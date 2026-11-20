/* Offshorly audit embed. Usage: <div data-offshorly-audit></div><script src="https://<tool>/embed.js" async></script> */
(function () {
  'use strict';
  var script = document.currentScript;
  if (!script || !script.src) return;
  var toolOrigin = new URL(script.src).origin;

  function mount(host) {
    if (host.getAttribute('data-offshorly-mounted')) return;
    host.setAttribute('data-offshorly-mounted', '1');
    var iframe = document.createElement('iframe');
    iframe.src = toolOrigin + '/?embed=1';
    iframe.title = 'Website and AI audit';
    iframe.loading = 'eager';
    iframe.setAttribute('scrolling', 'no');
    // "Copy link" writes to the clipboard from inside the frame. No sandbox attribute: it would
    // block the "Save as PDF" print window.
    iframe.setAttribute('allow', 'clipboard-write');
    iframe.style.cssText = 'display:block;width:100%;min-height:720px;border:0;overflow:hidden;background:transparent';
    host.appendChild(iframe);

    window.addEventListener('message', function (event) {
      // Only messages from this tool, sent by this iframe.
      if (event.origin !== toolOrigin || event.source !== iframe.contentWindow) return;
      var data = event.data;
      if (!data || typeof data.type !== 'string') return;
      if (data.type === 'offshorly-audit:resize') {
        var h = Number(data.height);
        if (isFinite(h) && h > 0 && h < 100000) iframe.style.height = Math.ceil(h) + 'px';
      } else if (data.type === 'offshorly-audit:scrolltop') {
        var top = iframe.getBoundingClientRect().top;
        if (top < 0 || top > window.innerHeight * 0.5) {
          window.scrollTo({ top: Math.max(0, window.pageYOffset + top - 80), behavior: 'smooth' });
        }
      }
    });
  }

  function init() {
    var hosts = document.querySelectorAll('[data-offshorly-audit]');
    for (var i = 0; i < hosts.length; i++) mount(hosts[i]);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
