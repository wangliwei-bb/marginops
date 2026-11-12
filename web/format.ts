const integer = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });

export const money = (value: number) => `${value < 0 ? "−" : ""}¥${integer.format(Math.abs(value))}`;
export const signedMoney = (value: number) => `${value > 0 ? "+" : ""}${money(value)}`;
