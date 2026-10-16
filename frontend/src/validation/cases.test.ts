import cases from '../../../mock/validation/cases.json';
import { validators } from './index';

describe('shared validation cases', () => {
  for (const c of cases.cases) {
    it(`${c.schema}: ${c.name}`, () => {
      const validate = validators[c.schema as keyof typeof validators];
      expect(validate, `no validator for ${c.schema}`).toBeDefined();
      expect(validate(c.input)).toEqual(c.fieldErrors);
    });
  }
});
