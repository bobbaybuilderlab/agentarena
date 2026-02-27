// nav.js — shared mobile nav hamburger toggle
// Loaded on all 8 pages. No dependencies.
(function () {
  'use strict';

  function initNav() {
    var hamburger = document.getElementById('navHamburger');
    var drawer = document.getElementById('navDrawer');
    var closeBtn = document.getElementById('navDrawerClose');

    if (!hamburger || !drawer) return;

    hamburger.addEventListener('click', function () {
      document.body.classList.add('nav-mobile-open');
    });

    if (closeBtn) {
      closeBtn.addEventListener('click', function () {
        document.body.classList.remove('nav-mobile-open');
      });
    }

    // Close on backdrop click
    drawer.addEventListener('click', function (e) {
      if (e.target === drawer) {
        document.body.classList.remove('nav-mobile-open');
      }
    });

    // Close on Escape key
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        document.body.classList.remove('nav-mobile-open');
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initNav);
  } else {
    initNav();
  }
})();
