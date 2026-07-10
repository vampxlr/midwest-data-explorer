/**
 * Marketing data layer: GA4 (gtag) + Meta Pixel, both injected only when the
 * owner has configured their ids in the Growth settings. Server-side Meta CAPI
 * fires from the backend on signup/subscribe — this covers the browser side.
 * trackEvent() fans one event out to dataLayer, gtag and fbq.
 */
let booted = false;

export function initTracking({ ga4Id, metaPixelId } = {}) {
  if (booted) return;
  booted = true;
  window.dataLayer = window.dataLayer || [];

  if (ga4Id) {
    const s = document.createElement('script');
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(ga4Id)}`;
    document.head.appendChild(s);
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', ga4Id);
  }

  if (metaPixelId && !window.fbq) {
    const n = (window.fbq = function () {
      n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
    });
    n.push = n; n.loaded = true; n.version = '2.0'; n.queue = [];
    const t = document.createElement('script');
    t.async = true;
    t.src = 'https://connect.facebook.net/en_US/fbevents.js';
    document.head.appendChild(t);
    window.fbq('init', metaPixelId);
    window.fbq('track', 'PageView');
  }
}

const FB_STANDARD = { sign_up: 'CompleteRegistration', begin_trial: 'StartTrial', purchase: 'Subscribe', begin_checkout: 'InitiateCheckout' };

export function trackEvent(name, params = {}) {
  try {
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({ event: name, ...params });
    if (window.gtag) window.gtag('event', name, params);
    if (window.fbq) FB_STANDARD[name] ? window.fbq('track', FB_STANDARD[name], params) : window.fbq('trackCustom', name, params);
  } catch {}
}
