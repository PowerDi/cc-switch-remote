import React from "react";
import { cn } from "@/lib/utils";

interface ListItemRowProps {
  isLast?: boolean;
  className?: string;
  children: React.ReactNode;
}

export const ListItemRow: React.FC<ListItemRowProps> = ({
  isLast,
  className,
  children,
}) => {
  return (
    <div
      className={cn(
        "group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-subtle",
        !isLast && "border-b border-border",
        className,
      )}
    >
      {children}
    </div>
  );
};
