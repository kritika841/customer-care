"use client";

import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";

function getSystemPreference(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function getStoredDark(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const stored = localStorage.getItem("satmi-theme") || localStorage.getItem("theme");
    if (stored === "dark" || stored === "midnight") return true;
    if (stored === "light") return false;
    return getSystemPreference();
  } catch {
    return getSystemPreference();
  }
}

function applyTheme(isDark: boolean) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.toggle("dark", isDark);
  root.style.colorScheme = isDark ? "dark" : "light";
  root.dataset.theme = isDark ? "dark" : "light";
}

const listeners = new Set<() => void>();

function subscribe(callback: () => void) {
  listeners.add(callback);
  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const handleMediaChange = () => {
    const stored = localStorage.getItem("satmi-theme") || localStorage.getItem("theme");
    if (!stored || stored === "system") {
      applyTheme(mediaQuery.matches);
      callback();
    }
  };
  const handleStorageChange = (e: StorageEvent) => {
    if (e.key === "satmi-theme" || e.key === "theme") {
      applyTheme(getStoredDark());
      callback();
    }
  };
  mediaQuery.addEventListener("change", handleMediaChange);
  window.addEventListener("storage", handleStorageChange);
  return () => {
    listeners.delete(callback);
    mediaQuery.removeEventListener("change", handleMediaChange);
    window.removeEventListener("storage", handleStorageChange);
  };
}

function getSnapshot(): boolean {
  return getStoredDark();
}

function getServerSnapshot(): boolean | null {
  return null;
}

export default function ThemeToggle() {
  const isDark = useSyncExternalStore<boolean | null>(subscribe, getSnapshot, getServerSnapshot);

  function toggleTheme() {
    const nextDark = !isDark;
    applyTheme(nextDark);
    try {
      localStorage.setItem("satmi-theme", nextDark ? "dark" : "light");
      localStorage.setItem("theme", nextDark ? "dark" : "light");
    } catch {
      // storage unavailable
    }
    listeners.forEach((cb) => cb());
  }

  if (isDark === null) {
    return (
      <button
        type="button"
        aria-label="Toggle theme"
        className="flex size-9 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground transition hover:border-ring/50 hover:bg-muted hover:text-foreground"
      >
        <span className="size-4" />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      title={isDark ? "Switch to light theme" : "Switch to dark theme"}
      className="flex size-9 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground transition hover:border-ring/50 hover:bg-muted hover:text-foreground cursor-pointer"
    >
      {isDark ? <Sun size={17} className="text-amber-400" /> : <Moon size={17} className="text-foreground" />}
    </button>
  );
}
