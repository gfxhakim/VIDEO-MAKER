"use client";
import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "@/lib/utils";

function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "peer relative inline-flex h-5 w-9 shrink-0 pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-x-1 pointer-coarse:after:-inset-y-3 items-center rounded-full border border-transparent shadow-xs transition-all outline-none data-[state=checked]:bg-primary data-[state=unchecked]:bg-input focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block size-4 rounded-full bg-foreground ring-0 transition-transform data-[state=checked]:translate-x-[calc(100%-2px)] data-[state=unchecked]:translate-x-0.5" />
    </SwitchPrimitive.Root>
  );
}
export { Switch };
