import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface DropdownOption {
  value: string;
  label: string;
  emoji?: string;
}

interface CustomDropdownProps {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  style?: React.CSSProperties;
  openUpward?: boolean;
  portal?: boolean;
}

interface PortalMenuPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

export default function CustomDropdown({
  value,
  options,
  onChange,
  disabled = false,
  placeholder = 'Select...',
  style = {},
  openUpward = false,
  portal = false,
}: CustomDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [portalMenuPosition, setPortalMenuPosition] = useState<PortalMenuPosition | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find((opt) => opt.value === value);

  const updatePortalMenuPosition = useCallback(() => {
    if (!dropdownRef.current) {
      return;
    }

    const triggerRect = dropdownRef.current.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const gap = 4;
    const spaceAbove = triggerRect.top - gap;
    const spaceBelow = viewportHeight - triggerRect.bottom - gap;
    const shouldOpenUpward = openUpward || (spaceBelow < 260 && spaceAbove > spaceBelow);
    const availableSpace = Math.max(shouldOpenUpward ? spaceAbove : spaceBelow, 120);
    const maxHeight = Math.min(300, availableSpace);

    setPortalMenuPosition({
      top: shouldOpenUpward
        ? Math.max(gap, triggerRect.top - maxHeight - gap)
        : Math.max(gap, Math.min(triggerRect.bottom + gap, viewportHeight - maxHeight - gap)),
      left: Math.max(gap, Math.min(triggerRect.left, viewportWidth - triggerRect.width - gap)),
      width: Math.min(triggerRect.width, viewportWidth - gap * 2),
      maxHeight,
    });
  }, [openUpward]);

  // Close dropdown when clicking outside or scrolling (but not when scrolling inside the dropdown)
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        (!menuRef.current || !menuRef.current.contains(event.target as Node))
      ) {
        setIsOpen(false);
      }
    };

    const handleScroll = (event: Event) => {
      // Don't close if scrolling within the dropdown menu itself
      if (menuRef.current && menuRef.current.contains(event.target as Node)) {
        return;
      }
      setIsOpen(false);
    };

    const handleMenuScroll = (event: Event) => {
      // Stop propagation to prevent parent scroll events from closing the dropdown
      event.stopPropagation();
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      window.addEventListener('scroll', handleScroll, true); // Use capture phase to catch all scroll events
      
      // Add scroll listener to menu to stop propagation
      if (menuRef.current) {
        menuRef.current.addEventListener('scroll', handleMenuScroll);
      }
      
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
        window.removeEventListener('scroll', handleScroll, true);
        if (menuRef.current) {
          menuRef.current.removeEventListener('scroll', handleMenuScroll);
        }
      };
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !portal) {
      return;
    }

    updatePortalMenuPosition();
    window.addEventListener('resize', updatePortalMenuPosition);

    return () => {
      window.removeEventListener('resize', updatePortalMenuPosition);
    };
  }, [isOpen, portal, updatePortalMenuPosition]);

  const handleSelect = (optionValue: string) => {
    onChange(optionValue);
    setIsOpen(false);
  };

  const handleToggle = () => {
    if (disabled) {
      return;
    }

    if (!isOpen && portal) {
      updatePortalMenuPosition();
    }

    setIsOpen((current) => !current);
  };

  const menuPositionStyle: React.CSSProperties = portal
    ? {
        position: 'fixed',
        top: portalMenuPosition?.top ?? 0,
        left: portalMenuPosition?.left ?? 0,
        width: portalMenuPosition?.width ?? '100%',
        maxHeight: portalMenuPosition?.maxHeight ?? 300,
      }
    : {
        position: 'absolute',
        ...(openUpward ? { bottom: '100%', marginBottom: '4px' } : { top: '100%', marginTop: '4px' }),
        left: 0,
        right: 0,
        maxHeight: '300px',
      };

  const dropdownMenu = isOpen && !disabled ? (
    <div
      ref={menuRef}
      style={{
        ...menuPositionStyle,
        background: '#1a1a1a',
        border: '1px solid #3a3a3a',
        borderRadius: '8px',
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.5)',
        zIndex: portal ? 10001 : 999999,
        overflowY: 'auto',
        overscrollBehavior: 'contain', // Prevent scroll chaining to parent
      }}
    >
      {options.map((option) => (
        <div
          key={option.value}
          onClick={() => handleSelect(option.value)}
          style={{
            padding: '0.65rem 0.75rem',
            cursor: 'pointer',
            color: value === option.value ? '#4ade80' : '#e5e7eb',
            background: value === option.value ? 'rgba(74, 222, 128, 0.1)' : 'transparent',
            transition: 'background 0.2s',
            fontSize: '0.9rem',
          }}
          onMouseEnter={(e) => {
            if (value !== option.value) {
              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)';
            }
          }}
          onMouseLeave={(e) => {
            if (value !== option.value) {
              e.currentTarget.style.background = 'transparent';
            }
          }}
        >
          {option.emoji && `${option.emoji} `}
          {option.label}
          {value === option.value && ' ✓'}
        </div>
      ))}
    </div>
  ) : null;

  return (
    <div
      ref={dropdownRef}
      style={{
        position: 'relative',
        width: '100%',
        ...style,
      }}
    >
      {/* Dropdown Button */}
      <div
        onClick={handleToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0.5rem 0.75rem',
          background: disabled ? 'rgba(255, 255, 255, 0.03)' : 'rgba(255, 255, 255, 0.05)',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          borderRadius: '6px',
          cursor: disabled ? 'not-allowed' : 'pointer',
          color: disabled ? '#666' : '#e5e7eb',
          fontSize: '0.9rem',
          transition: 'all 0.2s',
          opacity: disabled ? 0.5 : 1,
        }}
        onMouseEnter={(e) => {
          if (!disabled) {
            e.currentTarget.style.borderColor = 'rgba(74, 222, 128, 0.3)';
            e.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)';
          }
        }}
        onMouseLeave={(e) => {
          if (!disabled) {
            e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)';
            e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)';
          }
        }}
      >
        <span>
          {selectedOption ? (
            <>
              {selectedOption.emoji && `${selectedOption.emoji} `}
              {selectedOption.label}
            </>
          ) : (
            placeholder
          )}
        </span>
        <span
          style={{
            marginLeft: '0.5rem',
            transition: 'transform 0.2s',
            transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
          }}
        >
          ▾
        </span>
      </div>

      {/* Dropdown Menu */}
      {portal && dropdownMenu && typeof document !== 'undefined'
        ? createPortal(dropdownMenu, document.body)
        : dropdownMenu}
    </div>
  );
}
