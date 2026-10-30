(() => {
  const header = document.querySelector('.site-nav');
  if (!header) return;
  const toggle = header.querySelector('.site-nav__brand');
  const links = header.querySelector('.site-nav__links');
  function setOpen(open) {
    toggle.setAttribute('aria-expanded', String(open));
    links.hidden = !open;
  }
  toggle.addEventListener('click', () => setOpen(links.hidden));
  header.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !links.hidden) {
      setOpen(false);
      toggle.focus();
    }
  });
})();
