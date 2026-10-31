// The editor's preview: the page, in a frame of its own.
//
// An iframe rather than a div, because the coach app's stylesheet styles
// every button, heading and input on the page, and a preview drawn inside it
// would wear the app's clothes. The frame holds only site.css (inlined, so
// no second request) and the page's chosen fonts; React renders into it
// through a portal, so the preview is the same component tree as the page.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import siteCss from "./site.css?inline";

const FRAME_DOCUMENT = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>${siteCss}</style>
</head>
<body style="margin:0"><div id="site"></div></body>
</html>`;

export function SitePreviewFrame({
  fontsUrl,
  width,
  title,
  children,
}: {
  fontsUrl: string;
  /** CSS width of the frame: "100%" for desktop, a phone width to check small screens. */
  width: string;
  title: string;
  children: ReactNode;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [mount, setMount] = useState<HTMLElement | null>(null);

  // The frame's document exists only once it has loaded srcdoc; until then
  // there is nowhere to portal into.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const ready = () => setMount(frame.contentDocument?.getElementById("site") ?? null);
    if (frame.contentDocument?.getElementById("site")) ready();
    frame.addEventListener("load", ready);
    return () => frame.removeEventListener("load", ready);
  }, []);

  useEffect(() => {
    const head = frameRef.current?.contentDocument?.head;
    if (!head) return;
    let link = head.querySelector<HTMLLinkElement>("link[data-fonts]");
    if (!fontsUrl) {
      link?.remove();
      return;
    }
    if (!link) {
      link = head.ownerDocument.createElement("link");
      link.rel = "stylesheet";
      link.dataset.fonts = "1";
      head.appendChild(link);
    }
    if (link.href !== fontsUrl) link.href = fontsUrl;
  }, [fontsUrl, mount]);

  return (
    <iframe className="site-preview-frame" ref={frameRef} srcDoc={FRAME_DOCUMENT} title={title} style={{ width }}>
      {mount ? createPortal(children, mount) : null}
    </iframe>
  );
}
