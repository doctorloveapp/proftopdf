/** Wait for the next React commit before locating a newly mounted target. */
export function scrollToControl(id: string, focus = false) {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const target = document.getElementById(id);
      if (!target) return;
      target.scrollIntoView({
        behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
        block: "start",
      });
      if (focus) target.focus({ preventScroll: true });
    }),
  );
}
