const THEME_KEY = "fp-theme";

const toggleBtn = document.getElementById("theme-toggle");
const metaThemeColor = document.querySelector('meta[name="theme-color"]');

function currentTheme() {
  const explicit = document.documentElement.getAttribute("data-theme");
  if (explicit === "dark" || explicit === "light") return explicit;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function updateMetaThemeColor(theme) {
  if (!metaThemeColor) return;
  metaThemeColor.setAttribute("content", theme === "dark" ? "#0b1420" : "#185fa5");
}

function setTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage can be unavailable (private mode, disabled cookies) — the
    // toggle still works for the rest of the session, it just won't persist.
  }
  toggleBtn.setAttribute("aria-pressed", String(theme === "dark"));
  updateMetaThemeColor(theme);
}

export function initThemeToggle() {
  const theme = currentTheme();
  toggleBtn.setAttribute("aria-pressed", String(theme === "dark"));
  updateMetaThemeColor(theme);

  toggleBtn.addEventListener("click", () => {
    setTheme(currentTheme() === "dark" ? "light" : "dark");
  });
}
