import React from "react";

export interface ToolButtonProps {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  className?: string;
  onClick: () => void;
  tooltip?: string;
  disabled?: boolean;
}

export function ToolButton({
  icon,
  label,
  active,
  className = "",
  onClick,
  tooltip,
  disabled,
}: ToolButtonProps) {
  return (
    <button
      className={`video-tool-btn ${active ? "active" : ""} ${className}`.trim()}
      onClick={onClick}
      title={tooltip || label}
      aria-label={label}
      type="button"
      disabled={disabled}
      style={disabled ? { opacity: 0.45, cursor: "not-allowed" } : undefined}
    >
      {icon}
    </button>
  );
}
