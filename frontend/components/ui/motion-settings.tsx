"use client";
import { MotionConfig } from "motion/react";

/** App-wide motion defaults: people who ask their device for less motion get fades instead of
 *  slides, springs and layout moves in every `motion` component. */
export function MotionSettings({ children }: { children: React.ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
