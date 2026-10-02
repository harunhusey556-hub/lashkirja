"use client";

import { createContext, useContext, type ReactNode } from "react";

/** The shell owns the dialogs; root page titles host their buttons exactly once. */
export const PageHeaderActionsContext = createContext<ReactNode>(null);
export function usePageHeaderActions() {
  return useContext(PageHeaderActionsContext);
}
