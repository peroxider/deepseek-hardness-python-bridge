/* =========================================================================
   dsh-bridge landing site — minimal client JS
   - Copy-to-clipboard buttons on every <pre> block
   - Mark the current page in the nav (also handled by HTML, this is a fallback)
   ========================================================================= */
(function () {
  'use strict';

  // ---------- Copy buttons on <pre> blocks ----------
  document.querySelectorAll('pre').forEach(function (pre) {
    // Don't double-up if a copy button already exists
    if (pre.querySelector('.copy-btn')) return;

    var btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.type = 'button';
    btn.textContent = 'copy';
    btn.setAttribute('aria-label', 'Copy code to clipboard');

    btn.addEventListener('click', function () {
      var code = pre.querySelector('code') || pre;
      var text = code.innerText;
      var done = function () {
        btn.textContent = 'copied';
        btn.classList.add('copied');
        setTimeout(function () {
          btn.textContent = 'copy';
          btn.classList.remove('copied');
        }, 1400);
      };
      var fail = function () {
        btn.textContent = 'error';
        setTimeout(function () { btn.textContent = 'copy'; }, 1400);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, fail);
      } else {
        // Fallback for non-secure contexts
        try {
          var ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          var ok = document.execCommand('copy');
          document.body.removeChild(ta);
          ok ? done() : fail();
        } catch (_) { fail(); }
      }
    });

    pre.appendChild(btn);
  });

  // ---------- Highlight the current page in the nav (fallback) ----------
  // Pages already add `class="active"` to their nav link, but if a page forgot,
  // this catches it from the URL path.
  try {
    var here = window.location.pathname.split('/').pop() || 'index.html';
    if (here === '') here = 'index.html';
    document.querySelectorAll('.nav-links a').forEach(function (a) {
      var href = (a.getAttribute('href') || '').split('#')[0];
      if (href === here && !a.classList.contains('active')) {
        a.classList.add('active');
      }
    });
  } catch (_) { /* no-op */ }
})();