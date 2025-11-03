import { roundToStep } from '../src/lib/format';
import { normalizeOrder, checkLeverage } from '../src/lib/risk';
test('roundToStep rounds correctly', () => {
    expect(roundToStep(1.2345, 0.01)).toBe(1.23);
    expect(roundToStep(1.235, 0.01)).toBe(1.24);
    expect(roundToStep(100, undefined)).toBe(100);
});
test('normalizeOrder applies tick and step', () => {
    const meta = { tickSize: 0.5, stepSize: 0.1 };
    const req = { symbol: 'TEST', side: 'BUY', type: 'LIMIT', quantity: 1.23, price: 100.26 };
    const out = normalizeOrder(req, meta);
    expect(out.price).toBe(100.5);
    expect(out.quantity).toBe(1.2);
});
test('checkLeverage enforces caps', () => {
    checkLeverage(5, { maxLeverage: 10 });
    expect(() => checkLeverage(20, { maxLeverage: 10 })).toThrow();
});
