import React from 'react';

export default function Field({
  label,
  required = false,
  error = '',
  hint = '',
  helper = '',
  id,
  className = '',
  as,
  isTextarea = false,
  children,
  ...props
}) {
  const effectiveHint = error ? '' : (hint || helper);
  const inputId = id || (label ? `field_${label.replace(/\s+/g, '_')}` : undefined);
  const hintId = inputId ? `${inputId}_hint` : undefined;

  const Component = as || (isTextarea || props.rows ? 'textarea' : 'input');

  return (
    <div className={`grid gap-[5px] w-full ${className}`}>
      {label && (
        <label
          htmlFor={inputId}
          className="text-[13px] font-bold text-sg-ink flex items-center select-none"
        >
          <span>{label}</span>
          {required && (
            <span className="text-sg-brown ml-1 font-bold" aria-hidden="true">
              *
            </span>
          )}
        </label>
      )}

      {children ? (
        children
      ) : (
        <Component
          id={inputId}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={hintId}
          className={`min-h-[44px] rounded-[12px] border-[1.5px] bg-sg-paper px-3 py-[10px] text-[16px] text-sg-ink placeholder:text-sg-full focus:border-sg-brown focus:ring-[3px] focus:ring-sg-brown-soft focus:outline-none transition-colors ${
            error ? 'border-sg-danger' : 'border-sg-line'
          }`}
          {...props}
        />
      )}

      {error ? (
        <p id={hintId} className="text-[12px] text-sg-danger leading-[1.4]" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="sg-small">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
