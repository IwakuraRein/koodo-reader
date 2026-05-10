import { getIframeDoc } from "./docUtil";
import { ConfigService } from "../../assets/lib/kookit-extra-browser.min";
import { applyThemeColor, removeThemeColor } from "./themeUtil";
import { StyleHelper } from "../../assets/lib/kookit.min";

class styleUtil {
  // add default css for iframe
  static addDefaultCss(bookKey: string) {
    let doc = getIframeDoc("ANY")[0];
    if (!doc) return;
    let background = document.querySelector(".viewer");
    if (!background) return;
    background.setAttribute(
      "style",
      `background-color:${
        ConfigService.getReaderConfig("isMergeWord") === "yes"
          ? "rgba(0,0,0,0)"
          : ConfigService.getReaderConfig("backgroundColor") ||
            "rgba(255,255,255,1)"
      };filter: brightness(${
        ConfigService.getReaderConfig("brightness") || 1
      }) invert(${
        ConfigService.getReaderConfig("isInvert") === "yes" ? 1 : 0
      });`
    );
    if (!doc.head) {
      return;
    }
    //get style with id of default-style
    let styleElement = doc.getElementById("default-style");
    if (styleElement) {
      styleElement.textContent = this.getDefaultCss(bookKey);
    } else {
      let css = this.getDefaultCss(bookKey);
      let style = doc.createElement("style");
      style.id = "default-style";
      style.textContent = css;
      doc.head.appendChild(style);
    }
    // inject custom book CSS if enabled
    let customCssElement = doc.getElementById("custom-book-style");
    const isCustomBookCSS =
      ConfigService.getReaderConfig("isCustomBookCSS") === "yes";
    const customBookCSS = ConfigService.getReaderConfig("customBookCSS") || "";
    if (isCustomBookCSS && customBookCSS) {
      if (customCssElement) {
        customCssElement.textContent = customBookCSS;
      } else {
        let customStyle = doc.createElement("style");
        customStyle.id = "custom-book-style";
        customStyle.textContent = customBookCSS;
        doc.head.appendChild(customStyle);
      }
    } else if (customCssElement) {
      customCssElement.textContent = "";
    }
  }
  // get default css for iframe
  static getDefaultCss(bookKey: string) {
    const css = this.fixDefaultCss(
      StyleHelper.getDefaultCss(ConfigService, bookKey)
    );
    return css;
  }

  static fixDefaultCss(css: string) {
    // the default css display head and title
    return (
      css
        .replace(/,\s*title(?=\s*\{)/g, "")
        .replace(/;?\s*display:\s*contents\s*!important;?/g, ";") +
      "head,title{display:none!important;}"
    );
  }

  static applyTheme() {
    const themeColor = ConfigService.getReaderConfig("themeColor");
    if (themeColor && themeColor !== "default") {
      applyThemeColor(themeColor);
    } else {
      removeThemeColor();
    }
  }
}

export default styleUtil;
