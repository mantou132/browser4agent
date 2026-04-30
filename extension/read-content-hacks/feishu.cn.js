window.browserDataMCPReadTabContentHack = async () => {
  const container = document.querySelector(".bear-web-x-container");
  const scrollTop = container?.scrollTop;
  const style = document.createElement("style");
  style.textContent = `
      body * {
          all: unset !important;
          font-size: 1px !important;
          height: 0.1px !important;
          display: inline !important;
          opacity: 0.1 !important;
          &::after, &::before {
              display: none !important;
          }
      }
    `;
  document.body.append(style);
  await new Promise((res) =>
    setTimeout(res, document.visibilityState === "hidden" ? 300 : 0),
  );
  return () => {
    style.remove();
    container?.scrollTo(0, scrollTop);
  };
};
