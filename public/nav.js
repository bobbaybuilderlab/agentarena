// nav.js — shared mobile nav hamburger toggle
// Loaded on all 8 pages. No dependencies.
(function () {
  'use strict';

  function initNav() {
    var hamburger = document.getElementById('navHamburger');
    var drawer = document.getElementById('navDrawer');
    var closeBtn = document.getElementById('navDrawerClose');

    if (!hamburger || !drawer) return;

    function openNav() {
      document.body.classList.add('nav-mobile-open');
      hamburger.setAttribute('aria-expanded', 'true');
    }

    function closeNav() {
      document.body.classList.remove('nav-mobile-open');
      hamburger.setAttribute('aria-expanded', 'false');
    }

    hamburger.addEventListener('click', function () {
      openNav();
    });

    if (closeBtn) {
      closeBtn.addEventListener('click', function () {
        closeNav();
      });
    }

    // Close on backdrop click
    drawer.addEventListener('click', function (e) {
      if (e.target === drawer) {
        closeNav();
      }
    });

    // Close on Escape key
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        closeNav();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initNav);
  } else {
    initNav();
  }
})();
