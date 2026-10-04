import { useEffect, useState } from "react";

/**
 * The width below which the workspace uses its phone layout: a tab bar along
 * the bottom instead of the sidebar, and Today as the first screen.
 *
 * Width rather than "is this the staff app": the staff app is a shell around
 * this same site, so on a phone it is narrow anyway, and an iPad running it
 * keeps the full workspace. The stylesheet's phone rules use the same number.
 */
export const PHONE_LAYOUT_QUERY = "(max-width: 760px)";

export function isPhoneLayout() {
  return typeof window !== "undefined" && window.matchMedia?.(PHONE_LAYOUT_QUERY).matches === true;
}

/** Whether the phone layout is on, following the window as it is resized or rotated. */
export function usePhoneLayout() {
  const [phone, setPhone] = useState(isPhoneLayout);
  useEffect(() => {
    const query = window.matchMedia?.(PHONE_LAYOUT_QUERY);
    if (!query) return;
    const update = () => setPhone(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return phone;
}
