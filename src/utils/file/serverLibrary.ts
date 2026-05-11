import Book from "../../models/Book";
import { ConfigService } from "../../assets/lib/kookit-extra-browser.min";
import DatabaseService from "../storage/databaseService";

export const SERVER_BOOK_PREFIX = "server-";
const SERVER_LIBRARY_API = "/api/server-library";
const SERVER_LIBRARY_SYNC_INTERVAL = 5000;
let lastServerModeCheckAt = 0;
let cachedServerModeEnabled = false;
let lastServerLibrarySyncAt = 0;

export interface ServerLibraryBook extends Book {
  relativePath?: string;
  modifiedTime?: string;
}

export function isServerBookKey(key: string) {
  return key.startsWith(SERVER_BOOK_PREFIX);
}

export function isServerBookPath(bookPath: string) {
  return (
    !!bookPath &&
    (bookPath.startsWith(`${SERVER_LIBRARY_API}/book/`) ||
      bookPath.startsWith(`${window.location.origin}${SERVER_LIBRARY_API}/book/`))
  );
}

async function fetchJson(url: string) {
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) {
    return null;
  }
  return response.json();
}

async function isServerModeEnabled() {
  const now = Date.now();
  if (now - lastServerModeCheckAt < SERVER_LIBRARY_SYNC_INTERVAL) {
    return cachedServerModeEnabled;
  }

  try {
    const result = await fetchJson(`${SERVER_LIBRARY_API}/config`);
    cachedServerModeEnabled = !!(result && result.success && result.enabled);
  } catch (error) {
    cachedServerModeEnabled = false;
  }
  lastServerModeCheckAt = now;
  return cachedServerModeEnabled;
}

function normalizeServerBook(book: ServerLibraryBook) {
  return {
    key: book.key,
    name: book.name,
    author: book.author || "",
    description: book.description || "",
    md5: book.md5,
    cover: book.cover || "",
    format: book.format,
    publisher: book.publisher || "",
    size: book.size || 0,
    page: book.page || 0,
    path: book.path,
    charset: book.charset || "",
  };
}

function clearDeletedServerBooks(serverKeys: Set<string>) {
  const deletedBooks = ConfigService.getAllListConfig("deletedBooks") || [];
  const filteredDeletedBooks = deletedBooks.filter(
    (key: string) => !serverKeys.has(key)
  );
  if (filteredDeletedBooks.length !== deletedBooks.length) {
    ConfigService.setAllListConfig(filteredDeletedBooks, "deletedBooks", false);
  }
}

export async function syncServerLibraryBooks() {
  const now = Date.now();
  if (now - lastServerLibrarySyncAt < SERVER_LIBRARY_SYNC_INTERVAL) {
    return;
  }

  if (!(await isServerModeEnabled())) {
    return;
  }

  const result = await fetchJson(`${SERVER_LIBRARY_API}/books`);
  if (!result || !result.success || !Array.isArray(result.books)) {
    return;
  }

  const serverBooks: Book[] = result.books.map(normalizeServerBook);
  const serverKeys: Set<string> = new Set(
    serverBooks.map((book: Book) => book.key)
  );
  const localBooks: Book[] = (await DatabaseService.getAllRecords("books")) || [];
  const nonServerBooks = localBooks.filter(
    (book) => !isServerBookKey(book.key)
  );

  clearDeletedServerBooks(serverKeys);
  await DatabaseService.saveAllRecords(
    [...nonServerBooks, ...serverBooks],
    "books",
    false
  );
  lastServerLibrarySyncAt = now;
}
