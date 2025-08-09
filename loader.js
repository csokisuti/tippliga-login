// 1. Loader HTML-t beillesztjük az oldal tetejére
document.body.insertAdjacentHTML("afterbegin", `
  <div id="loaderOverlay">
    <div class="loader">
      <span class="ball">⚽</span>
      <div>Betöltés…</div>
    </div>
  </div>
`);

// 2. Függvény, amivel bárhol elrejtheted a loadert
window.hideLoader = function () {
  const loader = document.getElementById("loaderOverlay");
  if (loader) loader.style.display = "none";
};
