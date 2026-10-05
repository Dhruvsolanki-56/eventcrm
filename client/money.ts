/** Every amount in Encore is shown in Indian rupees with Indian digit grouping (₹12,34,567). The server stores plain numbers, so this is display only. */
const rupees = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

/** `minor` is the stored value in paise (hundredths of a rupee). */
export const formatMoney = (minor: number) => rupees.format(minor / 100);
export const currencyCode = 'INR';
export const currencySymbol = '₹';
