// nav.js — shared mobile nav hamburger toggle
// Loaded on all 8 pages. No dependencies.
(function () {
  'use strict';

  function initNav() {
    var hamburger = document.getElementById('navHamburger');
    var drawer = document.getElementById('navDrawer');
    var closeBtn = document.getElementById('navDrawerClose');
    var lastFocused = null;

    if (!hamburger || !drawer) return;

    var focusableSelector = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

    function getFocusableElements() {
      return Array.prototype.slice.call(drawer.querySelectorAll(focusableSelector)).filter(function (el) {
        return !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true';
      });
    }

    function isOpen() {
      return document.body.classList.contains('nav-mobile-open');
    }

    function openNav() {
      lastFocused = document.activeElement;
      document.body.classList.add('nav-mobile-open');
      hamburger.setAttribute('aria-expanded', 'true');
      drawer.hidden = false;
      drawer.setAttribute('aria-hidden', 'false');
      if (closeBtn) closeBtn.focus();
    }

    function closeNav() {
      document.body.classList.remove('nav-mobile-open');
      hamburger.setAttribute('aria-expanded', 'false');
      drawer.hidden = true;
      drawer.setAttribute('aria-hidden', 'true');
      if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
      else hamburger.focus();
    }

    drawer.hidden = true;
    drawer.setAttribute('aria-hidden', 'true');

    hamburger.addEventListener('click', function () {
      if (isOpen()) {
        closeNav();
        return;
      }
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
      if (!isOpen()) return;
      if (e.key === 'Escape') {
        closeNav();
        return;
      }

      if (e.key === 'Tab') {
        var focusable = getFocusableElements();
        if (!focusable.length) return;
        var first = focusable[0];
        var last = focusable[focusable.length - 1];

        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initNav);
  } else {
    initNav();
  }
})();
