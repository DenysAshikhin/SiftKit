import React, { useEffect } from 'react';

export function ImageLightbox({ src, alt, onClose }: {
  src: string;
  alt: string;
  onClose(): void;
}) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        onClose();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      onClick={onClose}
    >
      <button
        type="button"
        className="image-lightbox-close"
        aria-label="Close image"
        title="Close image"
        onClick={(event) => { event.stopPropagation(); onClose(); }}
      >
        ×
      </button>
      <img src={src} alt={alt} onClick={(event) => event.stopPropagation()} />
    </div>
  );
}
