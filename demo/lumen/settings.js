
(function () {
  const form = document.getElementById('settings-form');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
  });


  // line was never updated -> "TypeError: Cannot read properties of null" on every load.
  const save = document.querySelector('#save-btn');
  save.addEventListener('click', () => {
    save.textContent = window.t('set.saved');
  });
})();
