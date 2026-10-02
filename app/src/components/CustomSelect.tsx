"use client";

import { Fragment, Children, isValidElement, useEffect, useId, useRef, useState, type ChangeEvent, type ReactNode, type SelectHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { Icon } from "@/components/ds/Icon";

type Props = SelectHTMLAttributes<HTMLSelectElement>;

/** Controlled select with a viewport-bound menu and native form value. */
export function CustomSelect({ children, value, onChange, id, className = "", disabled, ...props }: Props) {
  const menuId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const native = useRef<HTMLSelectElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const anchorTop = useRef(0);
  const [placement, setPlacement] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [active, setActive] = useState(0);
  const collect = (nodes: ReactNode, group?: string): { value: string; label: ReactNode; shortLabel?: string; disabled: boolean; group?: string }[] =>
    Children.toArray(nodes).filter(isValidElement).flatMap(child => {
      const option = child.props as { value: string | number; children: ReactNode; disabled?: boolean; label?: string; "data-short-label"?: string };
      if (child.type === "optgroup") return collect(option.children, option.label);
      if (child.type !== "option") return [];
      return [{ value: String(option.value), label: option.children, shortLabel: option["data-short-label"], disabled: Boolean(option.disabled), group }];
    });
  const options = collect(children);
  const selected = options.findIndex(option => option.value === String(value ?? ""));
  const open = placement !== null;
  const close = () => setPlacement(null);
  const show = () => {
    if (disabled || !trigger.current) return;
    const rect = trigger.current.getBoundingClientRect();
    anchorTop.current = rect.top;
    const below = window.innerHeight - rect.bottom - 12;
    const height = Math.min(280, Math.max(below, rect.top - 12));
    setPlacement({ left: Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8)), top: below >= Math.min(280, options.length * 44 + 12) ? rect.bottom + 6 : Math.max(8, rect.top - height - 6), width: Math.min(rect.width, window.innerWidth - 16), height });
    setActive(selected >= 0 ? selected : 0);
  };
  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    if (native.current) {
      native.current.value = option.value;
      onChange?.({ target: native.current, currentTarget: native.current } as ChangeEvent<HTMLSelectElement>);
    }
    close();
    trigger.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setPlacement(null);
    };
    const reposition = (event: Event) => {
      if (event.type === "resize" || (!menu.current?.contains(event.target as Node) && Math.abs((trigger.current?.getBoundingClientRect().top ?? 0) - anchorTop.current) > 1)) setPlacement(null);
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", reposition);
    document.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", reposition);
      document.removeEventListener("scroll", reposition, true);
    };
  }, [open]);
  useEffect(() => {
    if (open) menu.current?.querySelector(`#${CSS.escape(menuId)}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, open, menuId]);
  return <>
    <select {...props} ref={native} value={value} onChange={onChange} disabled={disabled} hidden aria-hidden="true" tabIndex={-1}>{children}</select>
    <button {...{ id, disabled }} ref={trigger} type="button" role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? menuId : undefined} aria-activedescendant={open ? `${menuId}-${active}` : undefined} aria-required={props["aria-required"]} aria-invalid={props["aria-invalid"]} aria-describedby={props["aria-describedby"]} aria-label={props["aria-label"]} aria-labelledby={props["aria-labelledby"]} className={`custom-select-trigger ${className}`} onClick={() => open ? close() : show()} onKeyDown={event => {
      if (event.key === "Escape" || event.key === "Tab") { close(); return; }
      if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        if (!open) { show(); return; }
        if (event.key === "Enter" || event.key === " ") { choose(active); return; }
        let next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : Math.max(0, Math.min(options.length - 1, active + (event.key === "ArrowDown" ? 1 : -1)));
        while (options[next]?.disabled && next > 0 && next < options.length - 1) next += event.key === "ArrowUp" ? -1 : 1;
        setActive(next);
      } else if (event.key.length === 1) {
        const index = options.findIndex((option, index) => index > active && !option.disabled && String(option.label).toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase()));
        if (index >= 0) { if (!open) show(); setActive(index); }
      }
    }}><span className="min-w-0 truncate">{options[selected]?.shortLabel ?? options[selected]?.label ?? options[0]?.label}</span><Icon icon={ChevronDown} size="inline" /></button>
    {placement && createPortal(<div ref={menu} id={menuId} role="listbox" className="custom-select-menu" style={{ left: placement.left, top: placement.top, width: placement.width, maxHeight: placement.height }}>{options.map((option, index) => <Fragment key={option.value}>{option.group && option.group !== options[index - 1]?.group && <div className="px-3 py-2 text-caption text-ink-2" role="presentation">{option.group}</div>}<div title={option.group} id={`${menuId}-${index}`} role="option" aria-selected={index === selected} aria-disabled={option.disabled || undefined} className={`custom-select-option ${index === active ? "is-active" : ""}`} onPointerDown={event => event.preventDefault()} onPointerMove={() => !option.disabled && setActive(index)} onClick={() => choose(index)}><span>{option.label}</span>{index === selected && <Icon icon={Check} size="inline" />}</div></Fragment>)}</div>, document.body)}
  </>;
}
