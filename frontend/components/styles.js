// Shared inline styles, taken from docs/MFF-Core_module-ui-guide.md so the
// module looks native next to core's own pages.

export const subTabBar = {
  display: 'flex',
  borderBottom: '1px solid #dee2e6',
  marginBottom: '20px',
  backgroundColor: '#f8f9fa'
};

export function subTab(isActive) {
  return {
    padding: '10px 20px',
    cursor: 'pointer',
    backgroundColor: isActive ? '#ffffff' : 'transparent',
    borderBottom: isActive ? '2px solid #007bff' : 'none',
    fontWeight: isActive ? 'bold' : 'normal',
    border: isActive ? '1px solid #dee2e6' : 'none',
    fontSize: '13px'
  };
}

export const contentPanel = {
  backgroundColor: '#ffffff',
  padding: '20px',
  border: '1px solid #dee2e6',
  borderRadius: '0 0 4px 4px'
};

export const loading = { textAlign: 'center', padding: '20px' };

export const empty = {
  padding: '20px',
  color: '#999',
  fontStyle: 'italic',
  border: '1px solid #ddd',
  borderRadius: '4px'
};

export const errorBanner = {
  textAlign: 'center',
  padding: '20px',
  color: 'red',
  backgroundColor: '#ffeeee',
  borderRadius: '4px',
  margin: '10px 0'
};

export const warningBanner = {
  padding: '10px 14px',
  border: '1px solid #ffc107',
  backgroundColor: '#fff3cd',
  color: '#856404',
  borderRadius: '4px',
  margin: '0 0 15px 0',
  fontSize: '13px'
};

export const paragraph = { color: '#666', fontSize: '14px' };

export const tableWrapper = { border: '1px solid #ddd', borderRadius: '4px', overflow: 'auto' };
export const table = { width: '100%', borderCollapse: 'collapse' };
export const thead = { backgroundColor: '#f8f9fa' };
export const th = { padding: '12px', textAlign: 'left', borderBottom: '1px solid #ddd', fontSize: '13px' };
export const td = { padding: '12px', textAlign: 'left', borderBottom: '1px solid #eee', fontSize: '13px' };

export function chip(color) {
  const base = { display: 'inline-block', padding: '2px 6px', margin: '1px 3px 1px 0', borderRadius: '3px', fontSize: '11px' };
  if (color === 'warning') return { ...base, backgroundColor: '#fff3cd', color: '#856404' };
  return { ...base, color: 'white', backgroundColor: color };
}

export const GREEN = '#28a745';
export const RED = '#dc3545';
export const BLUE = '#007bff';
export const GREY = '#6c757d';

export function button(color, disabled) {
  return {
    padding: '5px 12px', color: 'white', border: 'none', borderRadius: '4px', fontSize: '12px', backgroundColor: color,
    cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1, marginRight: '6px'
  };
}

export const field = { padding: '5px 8px', border: '1px solid #ccc', borderRadius: '4px', fontSize: '13px' };
export const heading = { fontSize: '14px', fontWeight: 600, margin: '20px 0 8px' };
export const small = { color: '#666', fontSize: '12px' };
export const successBanner = {
  padding: '10px 14px', border: '1px solid #28a745', backgroundColor: '#e9f7ec', color: '#1c6b30',
  borderRadius: '4px', margin: '0 0 15px 0', fontSize: '13px'
};
