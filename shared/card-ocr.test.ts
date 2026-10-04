import { describe, expect, it } from 'vitest';
import { extractCardFields } from '../client/card-ocr.js';

describe('card text extraction', () => {
  it('extracts clear contact fields without claiming certainty', () => {
    const result = extractCardFields('ACME PACKAGING\nDemo Contact\nPackaging Buyer\ndemo.contact@sample.invalid\n+1 415 555 0199\nhttps://acme.co');
    expect(result).toMatchObject({
      name: 'Demo Contact', title: 'Packaging Buyer', company: 'ACME PACKAGING',
      email: 'demo.contact@sample.invalid', phone: '+1 415 555 0199', website: 'acme.co',
    });
    expect(result.uncertain).toEqual(['name', 'title', 'company', 'email', 'phone', 'website']);
  });

  it('does not invent a name or company from ambiguous text', () => {
    const result = extractCardFields('Customer success\ncontact@example.com\n555 987 6543');
    expect(result.name).toBe('');
    expect(result.company).toBe('');
    expect(result.email).toBe('contact@example.com');
  });

  it('keeps a title-case company out of the person field when its contact domain supports the company', () => {
    const result = extractCardFields('Northstar Materials\nJane Smith\nVP of Sales\njane.smith@northstarmaterials.com');
    expect(result.name).toBe('Jane Smith');
    expect(result.company).toBe('Northstar Materials');
  });

  it('leaves a possible company blank rather than calling it a person when the card has no person evidence', () => {
    const result = extractCardFields('Evergreen Materials\nSales Director\nhello@gmail.com');
    expect(result.name).toBe('');
    expect(result.company).toBe('');
  });

  it('does not treat a company printed under a title as a person', () => {
    const result = extractCardFields('Regional Sales Director\nNorthstar Materials\ninfo@gmail.com');
    expect(result.name).toBe('');
    expect(result.company).toBe('');
  });

  it('does not treat an all-caps company under a title as a person', () => {
    const result = extractCardFields('Regional Sales Director\nNORTHSTAR MATERIALS\ninfo@gmail.com');
    expect(result.name).toBe('');
    expect(result.company).toBe('NORTHSTAR MATERIALS');
  });

  it('does not mistake the local part of a damaged email for a website or lose the person name', () => {
    const result = extractCardFields('(0 ] Orchid Packaging Group\njamal.patel@orchidpackaginggroup.e:\nJamal Patel\nDesign Engineer\n+1 (206) 555-7462\nwww.orchidpackaginggroup.example');
    expect(result).toMatchObject({
      name: 'Jamal Patel', company: 'Orchid Packaging Group', email: '', website: 'www.orchidpackaginggroup.example',
    });
  });

  it('keeps a company when OCR combines it with the website on one line', () => {
    const result = extractCardFields('Chen Reed\nStrategic Accounts Lead\nsales@silverlineproducts.example\nSilverline Products LLC                        www.silverlineproducts.example');
    expect(result.name).toBe('Chen Reed');
    expect(result.company).toBe('Silverline Products LLC');
    expect(result.website).toBe('www.silverlineproducts.example');
  });

  it('strips OCR logo marks and trailing separators from the company value', () => {
    const result = extractCardFields('(P|  Pioneer Engineering LLC\nSofia Kim\nMarketing Specialist\nhello@pioneerengineeringllc.example\nwww.pioneerengineeringllc.example');
    expect(result.name).toBe('Sofia Kim');
    expect(result.company).toBe('Pioneer Engineering LLC');
  });

  it('uses a full email-name match to identify a person in a reversed layout', () => {
    const result = extractCardFields('Regional Sales Director\nMaya Chen\nmaya.chen@gmail.com');
    expect(result.name).toBe('Maya Chen');
    expect(result.company).toBe('');
  });

  it('recognizes a person below a company logotype and a title below the person', () => {
    const result = extractCardFields('NORTHSTAR MATERIALS\nMAYA CHEN\nAccount Executive\nmayachen@northstarmaterials.com');
    expect(result.name).toBe('MAYA CHEN');
    expect(result.company).toBe('NORTHSTAR MATERIALS');
  });

  it('keeps company/person assignments stable across 1,000 synthetic text-layout variants', () => {
    const people = ['Maya Chen', 'José Alvarez', 'Avery O’Neil', 'Noah Patel', 'Amira Hassan', 'Leo Martin', 'Sofia Rivera', 'Nora Kim', 'Owen Brooks', 'Ivy Thompson'];
    const companies = ['Northstar Materials', 'Orbit Labs', 'Acme Packaging', 'Harbor & Pine', 'Juniper Systems', 'Bluebird Technologies', 'Cedar Group', 'Summit Works', 'Brightline Studio', 'Fieldstone Partners'];
    const titles = ['Account Executive', 'Sales Director', 'Product Manager', 'Business Development Lead', 'Marketing Specialist', 'VP of Sales', 'Customer Success Manager', 'Design Engineer', 'Operations Director', 'Founder'];

    for (let i = 0; i < 1_000; i += 1) {
      const person = people[i % people.length]!;
      const company = companies[Math.floor(i / people.length) % companies.length]!;
      const title = titles[Math.floor(i / (people.length * companies.length)) % titles.length]!;
      const domain = company.toLowerCase().replace(/[^a-z0-9]/g, '');
      const style = i % 3;
      const printedCompany = style === 2 ? company.toLocaleUpperCase() : company;
      const printedPerson = style === 2 ? person.toLocaleUpperCase() : person;
      const text = style === 1
        ? `${printedPerson}\n${title}\n${printedCompany}\ncontact@${domain}.example`
        : `${printedCompany}\n${printedPerson}\n${title}\ncontact@${domain}.example`;
      const result = extractCardFields(text);
      expect(result.name, `synthetic layout ${i}`).toBe(printedPerson);
      expect(result.company, `synthetic layout ${i}`).toBe(printedCompany);
    }
  });

  it('joins an email split by a space before the @ instead of reading its first half as a website', () => {
    const result = extractCardFields('Designer\n\nFatima Haddad\nBRIGHTLINE SOFTWARE LLC\nfatima.haddad @brightlinesoftwarellc.example\n+1 (617) 555-3165\nwww. brightlinesoftwarellc.example');
    expect(result).toMatchObject({ name: 'Fatima Haddad', email: 'fatima.haddad@brightlinesoftwarellc.example', website: 'www.brightlinesoftwarellc.example' });
  });

  it('fixes an address whose company ending was misread, using the company name on the card', () => {
    const result = extractCardFields('Lucia Olsen\nSales Manager\nCedar Freight LLC\nlucia.olsen@cedarfreightlle.example\n+1 (206) 555-0142\nwww.cedarfreightlic.example');
    expect(result).toMatchObject({ company: 'Cedar Freight LLC', email: 'lucia.olsen@cedarfreightllc.example', website: 'www.cedarfreightllc.example' });
  });

  it('leaves a genuinely different address alone', () => {
    const result = extractCardFields('Lucia Olsen\nSales Manager\nCedar Freight LLC\nlucia.olsen@cedar-logistics.example\n+1 (206) 555-0142\nwww.cedar-logistics.example');
    expect(result).toMatchObject({ email: 'lucia.olsen@cedar-logistics.example', website: 'www.cedar-logistics.example' });
  });

  it('does not treat the stand-in details of a sample card as real', () => {
    const result = extractCardFields('OLIVIA ANDERSON\nyourname@email.com\n+123-456-7890\nwww.yourwebsite.com');
    expect(result).toMatchObject({ email: '', phone: '', website: '' });
    const real = extractCardFields('Sam Patel\nsam@patelfoods.com\n+1 415 555 0132\nwww.patelfoods.com');
    expect(real).toMatchObject({ email: 'sam@patelfoods.com', website: 'www.patelfoods.com' });
  });
});
