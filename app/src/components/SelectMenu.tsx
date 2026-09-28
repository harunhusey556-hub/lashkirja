"use client";

import React, { useState, useRef, useEffect } from "react";

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  badge?: string;
}

interface SelectMenuProps {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
}

export function SelectMenu({
  label,
  value,
  onChange,
  options,
  placeholder = "Valitse...",
  disabled = false,
  className = "",
  id,
}: SelectMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find((opt) => opt.value === value);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (disabled) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setIsOpen(!isOpen);
    } else if (e.key === "Escape") {
      setIsOpen(false);
    } else if (e.key === "ArrowDown" && isOpen) {
      e.preventDefault();
      const currentIndex = options.findIndex((opt) => opt.value === value);
      const nextOption = options[(currentIndex + 1) % options.length];
      if (nextOption) onChange(nextOption.value);
    } else if (e.key === "ArrowUp" && isOpen) {
      e.preventDefault();
      const currentIndex = options.findIndex((opt) => opt.value === value);
      const prevOption =
        options[(currentIndex - 1 + options.length) % options.length];
      if (prevOption) onChange(prevOption.value);
    }
  }

  return (
    <div className={`relative w-full ${className}`} ref={containerRef}>
      {label && (
        <label htmlFor={id} className="mb-1.5 block text-[13px] font-normal text-ink-2">
          {label}
        </label>
      )}
      <button
        id={id}
        type="button"
        disabled={disabled}
        onClick={() => setIsOpen(!isOpen)}
        onKeyDown={handleKeyDown}
        className={`w-full min-h-12 flex items-center justify-between px-3 rounded-card border text-left text-[16px] transition-colors active-press ${
          isOpen ? "border-accent bg-surface" : "border-line bg-surface"
        } ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span className={`truncate ${selectedOption ? "text-ink" : "text-ink-2"}`}>
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        <svg
          className={`w-4 h-4 text-ink-2 transition-transform duration-200 shrink-0 ml-2 ${
            isOpen ? "rotate-180 text-accent" : ""
          }`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>

      {isOpen && (
        <div
          className="absolute z-50 mt-1.5 w-full overflow-hidden overflow-y-auto rounded-card border border-line bg-surface py-1 max-h-60 shadow-xl scrollbar-none"
          role="listbox"
        >
          {options.map((opt) => {
            const isSelected = opt.value === value;
            return (
              <div
                key={opt.value}
                role="option"
                aria-selected={isSelected}
                onClick={() => {
                  onChange(opt.value);
                  setIsOpen(false);
                }}
                className={`flex cursor-pointer items-center justify-between px-3.5 py-2.5 text-[15px] transition-colors ${
                  isSelected ? "bg-accent-soft font-semibold text-accent" : "text-ink hover:bg-canvas"
                }`}
              >
                <div className="flex flex-col truncate pr-2">
                  <div className="flex items-center gap-2">
                    <span>{opt.label}</span>
                    {opt.badge && (
                      <span className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent">
                        {opt.badge}
                      </span>
                    )}
                  </div>
                  {opt.description && (
                    <span className="truncate text-xs font-normal text-ink-2">{opt.description}</span>
                  )}
                </div>
                {isSelected && (
                  <svg className="ml-1 h-4 w-4 shrink-0 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
