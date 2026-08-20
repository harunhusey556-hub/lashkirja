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
        <label
          htmlFor={id}
          className="block text-xs font-semibold text-charcoal-light uppercase tracking-wider mb-1.5"
        >
          {label}
        </label>
      )}
      <button
        id={id}
        type="button"
        disabled={disabled}
        onClick={() => setIsOpen(!isOpen)}
        onKeyDown={handleKeyDown}
        className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl border text-left text-sm transition-all duration-200 active-press ${
          isOpen
            ? "border-accent ring-2 ring-accent/20 bg-white shadow-sm"
            : "border-warm-gray-light/60 bg-white/80 hover:bg-white hover:border-warm-gray"
        } ${disabled ? "opacity-50 cursor-not-allowed bg-gray-100" : "cursor-pointer"}`}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span
          className={`truncate font-medium ${
            selectedOption ? "text-charcoal" : "text-warm-gray"
          }`}
        >
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        <svg
          className={`w-4 h-4 text-warm-gray transition-transform duration-200 shrink-0 ml-2 ${
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
          className="absolute z-50 mt-1.5 w-full bg-white/95 backdrop-blur-md rounded-2xl border border-warm-gray-light/40 shadow-xl overflow-hidden animate-popover py-1 max-h-60 overflow-y-auto scrollbar-none"
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
                className={`px-3.5 py-2.5 text-sm cursor-pointer flex items-center justify-between transition-colors duration-150 ${
                  isSelected
                    ? "bg-blush/40 text-accent-dark font-semibold"
                    : "text-charcoal hover:bg-cream/80"
                }`}
              >
                <div className="flex flex-col truncate pr-2">
                  <div className="flex items-center gap-2">
                    <span>{opt.label}</span>
                    {opt.badge && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-rose/15 text-accent-dark font-medium">
                        {opt.badge}
                      </span>
                    )}
                  </div>
                  {opt.description && (
                    <span className="text-xs text-warm-gray font-normal truncate">
                      {opt.description}
                    </span>
                  )}
                </div>
                {isSelected && (
                  <svg
                    className="w-4 h-4 text-accent shrink-0 ml-1"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2.5}
                      d="M5 13l4 4L19 7"
                    />
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
