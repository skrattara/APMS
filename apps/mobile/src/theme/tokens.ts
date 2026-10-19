export const colors = {
  brand: '#6B2C1F',
  brandLight: '#8B3A2A',
  canvas: '#F7F7F8',
  surface: '#FFFFFF',
  surfaceMuted: '#F9FAFB',
  border: '#E4E4E7',
  text: '#101828',
  textMuted: '#6A7282',
  success: '#009966',
  warning: '#BB4D00',
  danger: '#EF4444',
  info: '#155DFC',
} as const;

export const radius = { small: 5, medium: 8, large: 11, panel: 14, pill: 999 } as const;
export const space = { xxs: 4, xs: 6, sm: 8, md: 11, lg: 14, xl: 18, xxl: 22 } as const;
export const shadow = {
  shadowColor: '#101828',
  shadowOpacity: 0.045,
  shadowRadius: 8,
  shadowOffset: { width: 0, height: 2 },
  elevation: 1,
} as const;
