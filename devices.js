// Device profiles — kept in sync with the frontend (conceptx-device-preview.html).
// width/height are CSS logical pixels (the viewport the site actually sees).
// dsf = devicePixelRatio. isMobile/hasTouch tell the site it is a phone/tablet.

const IOS_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const WIN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const DEVICES = {
  // ---- Mobile ----
  ip17:   { label: "iPhone 17",                 w: 402,  h: 874,  dsf: 3, mobile: true,  ua: IOS_UA },
  s26:    { label: "Samsung Galaxy S26",        w: 360,  h: 780,  dsf: 3, mobile: true,  ua: ANDROID_UA },
  // ---- Desktop / laptop ----
  mbp14:  { label: 'MacBook Pro 14" (M5)',      w: 1512, h: 982,  dsf: 2, mobile: false, ua: MAC_UA },
  mbp16:  { label: 'MacBook Pro 16" (M5)',      w: 1728, h: 1117, dsf: 2, mobile: false, ua: MAC_UA },
  tbp7:   { label: 'Lenovo ThinkBook Plus 14"', w: 1400, h: 875,  dsf: 2, mobile: false, ua: WIN_UA },
  tpad:   { label: 'Lenovo ThinkPad (1920×1080)', w: 1920, h: 1080, dsf: 1, mobile: false, ua: WIN_UA },
  dell27: { label: 'Dell 27" (2560×1440)',        w: 2560, h: 1440, dsf: 1, mobile: false, ua: WIN_UA },
};

export const DEFAULT_DEVICE = "ip17";
