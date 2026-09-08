import { type ReactNode, useLayoutEffect, useRef } from "react";

/** Native modality owns background inertness, keyboard focus and restoration. */
export function ModalSurface({ title, className, children, onClose, dismissOnBackdrop = false }: {
  title: string;
  className: string;
  children: ReactNode;
  onClose: () => void;
  dismissOnBackdrop?: boolean;
}) {
  const element = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = element.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);

  return <dialog ref={element} className={`modal-surface ${className}`} aria-label={title} aria-modal="true"
    onCancel={(event) => { event.preventDefault(); event.stopPropagation(); onClose(); }}
    onClick={(event) => { if (dismissOnBackdrop && event.target === event.currentTarget) onClose(); }}>
    {children}
  </dialog>;
}
