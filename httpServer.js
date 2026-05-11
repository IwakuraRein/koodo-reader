const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
const crypto = require("crypto");

const SUPPORTED_FORMATS = new Set([
  ".epub",
  ".pdf",
  ".txt",
  ".mobi",
  ".azw3",
  ".azw",
  ".htm",
  ".html",
  ".xml",
  ".xhtml",
  ".mhtml",
  ".docx",
  ".md",
  ".fb2",
  ".cbz",
  ".cbt",
  ".cbr",
  ".cb7",
]);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".epub": "application/epub+zip",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".mobi": "application/x-mobipocket-ebook",
  ".azw": "application/vnd.amazon.ebook",
  ".azw3": "application/vnd.amazon.ebook",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".cbz": "application/x-cbz",
  ".cbr": "application/x-cbr",
  ".cbt": "application/x-cbt",
  ".cb7": "application/x-cb7",
};

function parseCliArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "true";
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

const cliArgs = parseCliArgs(process.argv.slice(2));
const requestedLibraryPath = cliArgs.library || process.env.KOODO_LIBRARY_PATH || "";

function getDockerSecret(secretName) {
  try {
    const secretPath = `/run/secrets/${secretName}`;
    if (fs.existsSync(secretPath)) {
      return fs.readFileSync(secretPath, "utf8").trim();
    }
  } catch (err) {
    console.warn(`Failed to read Docker secret '${secretName}':`, err.message);
  }
  return null;
}

const PORT = Number(cliArgs.port || process.env.PORT || 8080);
const HOST =
  cliArgs.host || process.env.HOST || (requestedLibraryPath ? "0.0.0.0" : "127.0.0.1");
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || "./uploads");
const BUILD_DIR = path.resolve(cliArgs.build || process.env.BUILD_DIR || "./build");
const SERVER_ENABLED =
  process.env.ENABLE_HTTP_SERVER === "true" || cliArgs.files === "true";
const LIBRARY_PATH = requestedLibraryPath;
const SERVER_MODE =
  cliArgs.server === "true" ||
  process.env.KOODO_SERVER_MODE === "true" ||
  !!LIBRARY_PATH;
const REQUIRE_AUTH = process.env.SERVER_AUTH === "true";
const SERVER_PASSWORD_FILE = process.env.SERVER_PASSWORD_FILE || "my_secret";
const SERVER_PASSWORD =
  getDockerSecret(SERVER_PASSWORD_FILE) ||
  process.env.SERVER_PASSWORD ||
  "securePass123";
const VALID_CREDENTIALS = {
  username: process.env.SERVER_USERNAME || "admin",
  password: SERVER_PASSWORD,
};

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

let cachedLibraryFiles = [];
let cachedAt = 0;

if (!SERVER_ENABLED && !SERVER_MODE) {
  console.info(
    "HTTP server is disabled. Set ENABLE_HTTP_SERVER=true, KOODO_LIBRARY_PATH, or pass --library <path>."
  );
  process.exit(0);
}

if (SERVER_ENABLED && !fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

if (SERVER_MODE && !LIBRARY_PATH) {
  console.error("Server mode needs a library path. Pass --library <path>.");
  process.exit(1);
}

const LIBRARY_ROOT = LIBRARY_PATH ? path.resolve(LIBRARY_PATH) : "";
if (SERVER_MODE) {
  if (!fs.existsSync(LIBRARY_ROOT) || !fs.statSync(LIBRARY_ROOT).isDirectory()) {
    console.error(`Library path does not exist or is not a directory: ${LIBRARY_ROOT}`);
    process.exit(1);
  }
  if (!fs.existsSync(BUILD_DIR)) {
    console.warn(
      `Build directory not found: ${BUILD_DIR}. Run "yarn build" before using browser server mode.`
    );
  }
}

function getServerOrigin(req) {
  const host = req.headers.host;
  if (!host) return null;
  const scheme =
    req.socket && req.socket.encrypted
      ? "https"
      : (req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  return `${scheme}://${host}`;
}

function applyCorsHeaders(req, res) {
  const origin = req.headers.origin;
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    return true;
  }
  return false;
}

function authenticate(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return false;

  const [scheme, credentials] = authHeader.split(" ");
  if (scheme !== "Basic" || !credentials) return false;

  const [username, password] = Buffer.from(credentials, "base64")
    .toString()
    .split(":");

  return (
    username === VALID_CREDENTIALS.username &&
    password === VALID_CREDENTIALS.password
  );
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, message) {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(message);
}

function sanitizeFilename(originalName) {
  return path.basename(originalName).replace(/[\\/:*?"<>|]/g, "_");
}

function resolveUploadPath(...pathSegments) {
  const targetPath = path.resolve(UPLOAD_DIR, ...pathSegments);
  const relativePath = path.relative(UPLOAD_DIR, targetPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("Invalid path");
  }
  return targetPath;
}

function resolveBuildPath(requestPath) {
  const decodedPath = decodeURIComponent(requestPath);
  const relative = decodedPath === "/" ? "index.html" : decodedPath.slice(1);
  const targetPath = path.resolve(BUILD_DIR, relative);
  const relativePath = path.relative(BUILD_DIR, targetPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("Invalid path");
  }
  return targetPath;
}

function normalizeRelativePath(filePath) {
  return path.relative(LIBRARY_ROOT, filePath).split(path.sep).join("/");
}

function getLibraryId(relativePath) {
  return crypto.createHash("sha1").update(relativePath).digest("hex").slice(0, 16);
}

function getBookName(filename) {
  const extension = path.extname(filename);
  return filename.slice(0, filename.length - extension.length) || filename;
}

function getBookRecord(filePath) {
  const stat = fs.statSync(filePath);
  const relativePath = normalizeRelativePath(filePath);
  const filename = path.basename(filePath);
  const extension = path.extname(filename).toLowerCase();
  const id = getLibraryId(relativePath);
  const format = extension.replace(".", "").toUpperCase();

  return {
    key: `server-${id}`,
    name: getBookName(filename),
    author: "",
    description: `Server library: ${path.dirname(relativePath)}`,
    md5: id,
    cover: "",
    format,
    publisher: "",
    size: stat.size,
    page: 0,
    path: `/api/server-library/book/${id}?name=${encodeURIComponent(filename)}`,
    charset: "",
    relativePath,
    modifiedTime: stat.mtime.toISOString(),
  };
}

function scanLibraryFiles() {
  if (!SERVER_MODE) return [];
  const now = Date.now();
  if (now - cachedAt < 3000) {
    return cachedLibraryFiles;
  }

  const result = [];
  const stack = [LIBRARY_ROOT];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (err) {
      console.warn(`Skipping unreadable directory ${currentDir}:`, err.message);
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;

      const extension = path.extname(entry.name).toLowerCase();
      if (SUPPORTED_FORMATS.has(extension)) {
        result.push(getBookRecord(fullPath));
      }
    }
  }

  result.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  cachedLibraryFiles = result;
  cachedAt = now;
  return result;
}

function getLibraryFileById(id) {
  const record = scanLibraryFiles().find((item) => item.key === `server-${id}`);
  if (!record) return null;
  const targetPath = path.resolve(LIBRARY_ROOT, record.relativePath);
  const relativePath = path.relative(LIBRARY_ROOT, targetPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return null;
  }
  return { record, targetPath };
}

function handleServerLibrary(req, res, parsedUrl) {
  if (!SERVER_MODE) {
    return sendJson(res, 404, { success: false, message: "Server mode is disabled" });
  }

  if (parsedUrl.pathname === "/api/server-library/config") {
    return sendJson(res, 200, {
      success: true,
      enabled: true,
      rootName: path.basename(LIBRARY_ROOT),
      totalCount: scanLibraryFiles().length,
    });
  }

  if (parsedUrl.pathname === "/api/server-library/books") {
    return sendJson(res, 200, {
      success: true,
      books: scanLibraryFiles(),
    });
  }

  const match = parsedUrl.pathname.match(/^\/api\/server-library\/book\/([a-f0-9]+)$/);
  if (!match) {
    return sendJson(res, 404, { success: false, message: "Not Found" });
  }

  const libraryFile = getLibraryFileById(match[1]);
  if (!libraryFile || !fs.existsSync(libraryFile.targetPath)) {
    return sendText(res, 404, "Book not found");
  }

  const stat = fs.statSync(libraryFile.targetPath);
  const extension = path.extname(libraryFile.targetPath).toLowerCase();
  const contentType = MIME_TYPES[extension] || "application/octet-stream";
  const filename = path.basename(libraryFile.targetPath);
  const encodedFilename = encodeURIComponent(filename);
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
      return res.end();
    }

    res.writeHead(206, {
      "Content-Type": contentType,
      "Content-Length": end - start + 1,
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Content-Disposition": `inline; filename="${encodedFilename}"; filename*=UTF-8''${encodedFilename}`,
    });
    return fs.createReadStream(libraryFile.targetPath, { start, end }).pipe(res);
  }

  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": stat.size,
    "Accept-Ranges": "bytes",
    "Content-Disposition": `inline; filename="${encodedFilename}"; filename*=UTF-8''${encodedFilename}`,
  });
  return fs.createReadStream(libraryFile.targetPath).pipe(res);
}

function handleStaticFile(req, res, parsedUrl) {
  if (!SERVER_MODE || !fs.existsSync(BUILD_DIR)) {
    return sendText(res, 404, "Not Found");
  }

  let filePath;
  try {
    filePath = resolveBuildPath(parsedUrl.pathname);
  } catch (err) {
    return sendText(res, 400, err.message);
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(BUILD_DIR, "index.html");
  }

  if (!fs.existsSync(filePath)) {
    return sendText(res, 404, "Build output not found");
  }

  const extension = path.extname(filePath).toLowerCase();
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
    "Content-Length": stat.size,
  });
  return fs.createReadStream(filePath).pipe(res);
}

function handleUpload(req, res, dirParam) {
  const contentType = req.headers["content-type"];
  if (!contentType || !contentType.includes("multipart/form-data")) {
    return sendText(res, 400, "Invalid Content-Type. Expected multipart/form-data");
  }

  const boundaryMatch = contentType.match(/boundary=(.+)$/);
  if (!boundaryMatch) {
    return sendText(res, 400, "Missing boundary in Content-Type");
  }

  const boundary = boundaryMatch[1];
  const body = [];
  req.on("data", (chunk) => body.push(chunk));
  req.on("end", () => {
    try {
      const parts = parseMultipart(Buffer.concat(body), boundary);
      if (!parts.file || !parts.filename) {
        throw new Error("No valid file uploaded");
      }

      const safeFilename = sanitizeFilename(parts.filename);
      if (!safeFilename || safeFilename === "." || safeFilename === "..") {
        return sendText(res, 400, "Invalid filename");
      }

      const targetDir = resolveUploadPath(dirParam);
      const filePath = resolveUploadPath(dirParam, safeFilename);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      fs.writeFile(filePath, parts.file, (err) => {
        if (err) {
          console.error("File write error:", err);
          return sendText(res, 500, "Internal Server Error");
        }

        return sendJson(res, 200, {
          success: true,
          filename: safeFilename,
          directory: dirParam,
          message: "File uploaded successfully",
        });
      });
    } catch (err) {
      console.error("Upload error:", err);
      return sendText(res, 400, err.message);
    }
  });
}

function parseMultipart(buffer, boundary) {
  const result = {};
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const parts = [];

  let start = 0;
  let end = buffer.indexOf(boundaryBuffer, start);

  while (end !== -1) {
    if (start !== 0) {
      parts.push(buffer.slice(start, end));
    }
    start = end + boundaryBuffer.length;
    end = buffer.indexOf(boundaryBuffer, start);
  }

  for (const part of parts) {
    if (part.length === 0) continue;
    const headerEndIndex = part.indexOf("\r\n\r\n");
    if (headerEndIndex === -1) continue;

    const headers = part.slice(0, headerEndIndex).toString();
    const content = part.slice(headerEndIndex + 4);
    const actualContent = content.slice(0, content.length - 2);
    const nameMatch = headers.match(/name="([^"]+)"/);
    const filenameMatch = headers.match(/filename="([^"]+)"/);

    if (nameMatch) {
      const name = nameMatch[1];
      if (filenameMatch && filenameMatch[1]) {
        result.filename = filenameMatch[1];
        result.file = actualContent;
      } else {
        result[name] = actualContent.toString();
      }
    }
  }

  return result;
}

function handleDownload(req, res, dirParam) {
  try {
    const parsedUrl = url.parse(req.url, true);
    const filename = parsedUrl.query.filename;
    if (!filename) return sendText(res, 400, "Missing filename parameter");

    const safeFilename = sanitizeFilename(filename);
    if (!safeFilename || safeFilename === "." || safeFilename === "..") {
      return sendText(res, 400, "Invalid filename");
    }

    const filePath = resolveUploadPath(dirParam, safeFilename);
    if (!fs.existsSync(filePath)) return sendText(res, 404, "File not found");

    const stat = fs.statSync(filePath);
    const encodedFilename = encodeURIComponent(safeFilename);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": stat.size,
      "Content-Disposition": `attachment; filename="${encodedFilename}"; filename*=UTF-8''${encodedFilename}`,
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error("Download error:", err);
    sendText(res, 400, err.message);
  }
}

function handleDelete(req, res, dirParam) {
  try {
    const parsedUrl = url.parse(req.url, true);
    const filename = parsedUrl.query.filename;
    if (!filename) return sendText(res, 400, "Missing filename parameter");

    const safeFilename = sanitizeFilename(filename);
    if (!safeFilename || safeFilename === "." || safeFilename === "..") {
      return sendText(res, 400, "Invalid filename");
    }

    const filePath = resolveUploadPath(dirParam, safeFilename);
    if (!fs.existsSync(filePath)) return sendText(res, 404, "File not found");
    if (!fs.statSync(filePath).isFile()) {
      return sendText(res, 400, "Target is not a file");
    }

    fs.unlink(filePath, (err) => {
      if (err) {
        console.error("File delete error:", err);
        return sendText(res, 500, "Internal Server Error");
      }
      return sendJson(res, 200, {
        success: true,
        filename: safeFilename,
        directory: dirParam,
        message: "File deleted successfully",
      });
    });
  } catch (err) {
    console.error("Delete error:", err);
    sendText(res, 400, err.message);
  }
}

function handleList(req, res, dirParam) {
  try {
    const targetDir = resolveUploadPath(dirParam);
    if (!fs.existsSync(targetDir)) return sendText(res, 404, "Directory not found");
    if (!fs.statSync(targetDir).isDirectory()) {
      return sendText(res, 400, "Target is not a directory");
    }

    fs.readdir(targetDir, { withFileTypes: true }, (err, entries) => {
      if (err) {
        console.error("Directory read error:", err);
        return sendText(res, 500, "Internal Server Error");
      }

      const fileList = entries.map((entry) => {
        const stat = fs.statSync(path.join(targetDir, entry.name));
        return {
          name: entry.name,
          type: entry.isDirectory() ? "directory" : "file",
          size: entry.isFile() ? stat.size : null,
          modifiedTime: stat.mtime.toISOString(),
          createdTime: stat.birthtime.toISOString(),
        };
      });

      fileList.sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      return sendJson(res, 200, {
        success: true,
        directory: dirParam,
        files: fileList,
        totalCount: fileList.length,
      });
    });
  } catch (err) {
    console.error("List error:", err);
    sendText(res, 400, err.message);
  }
}

function handleLegacyFileServer(req, res, parsedUrl) {
  if (!SERVER_ENABLED) return false;
  if (!["/upload", "/download", "/delete", "/list"].includes(parsedUrl.pathname)) {
    return false;
  }

  if (!authenticate(req)) {
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="Secure File Server"',
      "Content-Type": "text/plain; charset=utf-8",
    });
    res.end("Unauthorized");
    return true;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/upload") {
    handleUpload(req, res, parsedUrl.query.dir || "");
  } else if (req.method === "GET" && parsedUrl.pathname === "/download") {
    handleDownload(req, res, parsedUrl.query.dir || "");
  } else if (req.method === "DELETE" && parsedUrl.pathname === "/delete") {
    handleDelete(req, res, parsedUrl.query.dir || "");
  } else if (req.method === "GET" && parsedUrl.pathname === "/list") {
    handleList(req, res, parsedUrl.query.dir || "");
  } else {
    sendText(res, 405, "Method Not Allowed");
  }
  return true;
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  const serverOrigin = getServerOrigin(req);
  const isCrossOrigin = !!origin && origin !== serverOrigin;
  const corsAllowed = applyCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    if (isCrossOrigin && !corsAllowed) {
      return sendText(res, 403, "Origin not allowed");
    }
    res.writeHead(204);
    return res.end();
  }

  if (isCrossOrigin && !corsAllowed) {
    return sendText(res, 403, "Origin not allowed");
  }

  const parsedUrl = url.parse(req.url, true);
  if (REQUIRE_AUTH && !authenticate(req)) {
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="Koodo Reader Server"',
      "Content-Type": "text/plain; charset=utf-8",
    });
    return res.end("Unauthorized");
  }

  if (parsedUrl.pathname.startsWith("/api/server-library/")) {
    return handleServerLibrary(req, res, parsedUrl);
  }

  if (handleLegacyFileServer(req, res, parsedUrl)) {
    return;
  }

  return handleStaticFile(req, res, parsedUrl);
});

server.listen(PORT, HOST, () => {
  console.info(`Koodo Reader server running at http://${HOST}:${PORT}`);
  if (SERVER_MODE) {
    console.info(`Serving web build from: ${BUILD_DIR}`);
    console.info(`Serving library from: ${LIBRARY_ROOT}`);
    console.info(`Found ${scanLibraryFiles().length} supported books`);
  }
  if (SERVER_ENABLED) {
    console.info(`Legacy file API enabled. Upload directory: ${UPLOAD_DIR}`);
  }
  if (REQUIRE_AUTH) {
    console.info(`Basic auth enabled. Username: ${VALID_CREDENTIALS.username}`);
  }
});
