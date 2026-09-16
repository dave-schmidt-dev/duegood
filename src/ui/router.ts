import { mount } from "./app";

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount, { once: true });
} else {
  mount();
}
