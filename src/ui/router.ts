function element<K extends keyof HTMLElementTagNameMap>(
  name: K,
  attributes: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderShell(): void {
  const mount = document.querySelector<HTMLElement>("#app");
  if (!mount) throw new Error("Missing application mount point.");

  const shell = element("div", { class: "shell" });
  const main = element("main", { id: "main", class: "panel", tabindex: "-1" });
  main.appendChild(element("p", { class: "eyebrow" }, "Local foundation"));
  main.appendChild(element("h1", {}, "Due Good"));
  main.appendChild(
    element(
      "p",
      {},
      "A private student planning workspace is being prepared. No Canvas account is connected in this local scaffold.",
    ),
  );

  const status = element("div", { class: "status", role: "status", "aria-live": "polite" });
  status.appendChild(element("strong", {}, "Canvas connection unavailable"));
  status.appendChild(element("span", {}, " Institution-enabled OAuth has not been configured."));
  main.appendChild(status);
  shell.appendChild(main);
  mount.replaceChildren(shell);

  if (window.isSecureContext && "serviceWorker" in navigator) {
    void navigator.serviceWorker.register("/sw.js").catch(() => {
      status.replaceChildren(
        element("strong", {}, "Local app shell unavailable"),
        element("span", {}, " Reload after the secure test origin is ready."),
      );
    });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", renderShell, { once: true });
} else {
  renderShell();
}
