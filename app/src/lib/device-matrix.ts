import { usableArea, type UsableArea } from "./usable-area";

/**
 * Phone sizes the shell is checked against.
 * These are CSS and unit thresholds. They do not replace a WKWebView IPA
 * smoke: Chromium does not apply env(safe-area-inset-*) the way iOS does,
 * and it does not open the system keyboard over the visual viewport.
 */
export type DeviceProfile = {
  id: string;
  width: number;
  height: number;
  orientation: "portrait" | "landscape";
  /** Visual viewport offsetTop. Dynamic Island / notch when env() is missing. */
  offsetTop: number;
  viewportHeight: number;
  editableFocused: boolean;
  safeLeft: number;
  safeRight: number;
};

export const DEVICE_PROFILES: readonly DeviceProfile[] = [
  {
    id: "compact-portrait",
    width: 390,
    height: 844,
    orientation: "portrait",
    offsetTop: 47,
    viewportHeight: 844 - 47 - 34,
    editableFocused: false,
    safeLeft: 0,
    safeRight: 0,
  },
  {
    id: "large-portrait",
    width: 430,
    height: 932,
    orientation: "portrait",
    offsetTop: 59,
    viewportHeight: 932 - 59 - 34,
    editableFocused: false,
    safeLeft: 0,
    safeRight: 0,
  },
  {
    id: "compact-landscape",
    width: 844,
    height: 390,
    orientation: "landscape",
    offsetTop: 0,
    viewportHeight: 390 - 21,
    editableFocused: false,
    safeLeft: 47,
    safeRight: 47,
  },
  {
    id: "large-landscape",
    width: 932,
    height: 430,
    orientation: "landscape",
    offsetTop: 0,
    viewportHeight: 430 - 21,
    editableFocused: false,
    safeLeft: 59,
    safeRight: 59,
  },
  {
    id: "compact-keyboard",
    width: 390,
    height: 844,
    orientation: "portrait",
    offsetTop: 0,
    viewportHeight: 844 - 336,
    editableFocused: true,
    safeLeft: 0,
    safeRight: 0,
  },
  {
    id: "large-keyboard",
    width: 430,
    height: 932,
    orientation: "portrait",
    offsetTop: 59,
    viewportHeight: 932 - 59 - 320,
    editableFocused: true,
    safeLeft: 0,
    safeRight: 0,
  },
];

export type ProfileLayout = UsableArea & {
  contentWidth: number;
};

export function profileLayout(profile: DeviceProfile): ProfileLayout {
  return {
    ...usableArea({
      innerHeight: profile.height,
      offsetTop: profile.offsetTop,
      viewportHeight: profile.viewportHeight,
      editableFocused: profile.editableFocused,
    }),
    contentWidth: profile.width - profile.safeLeft - profile.safeRight,
  };
}

/** A row of 48px targets still fits beside the home-indicator side insets. */
export function contentClearsChrome(contentWidth: number): boolean {
  return contentWidth >= 280;
}
