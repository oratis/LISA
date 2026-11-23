"use strict";
// Same preference as the public website, applied before the first paint.
const siteThemeQuery = matchMedia("(prefers-color-scheme: dark)");
function applySiteTheme(preference) {
  const theme = ["light", "dark"].includes(preference) ? preference : "system";
  document.documentElement.dataset.preference = theme;
  document.documentElement.dataset.theme =
    theme === "system" ? (siteThemeQuery.matches ? "dark" : "light") : theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta)
    meta.content = document.documentElement.dataset.theme === "dark" ? "#0a0b0d" : "#f8f9fc";
}
function readSiteTheme() {
  try {
    return localStorage.getItem("lisa-site-theme") || "system";
  } catch {
    return "system";
  }
}
applySiteTheme(readSiteTheme());
siteThemeQuery.addEventListener("change", () => applySiteTheme(readSiteTheme()));
window.addEventListener("storage", (event) => {
  if (event.key === "lisa-site-theme" || event.key === null) {
    applySiteTheme(readSiteTheme());
    document.querySelectorAll("[data-theme-picker]").forEach((picker) => {
      picker.value = document.documentElement.dataset.preference;
    });
  }
});
