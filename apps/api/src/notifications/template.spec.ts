import { describe, expect, it } from 'vitest';
import { parseRecipients, renderBody, renderSubject, renderTableHtml, wrapHtml } from './template';

describe('renderSubject', () => {
  it('substitutes @fields as plain text', () => {
    expect(renderSubject('Shipment @ShipmentID - Order @Ordr', { ShipmentID: 12, Ordr: 145915 })).toBe(
      'Shipment 12 - Order 145915',
    );
  });

  it('renders null/undefined params as empty', () => {
    expect(renderSubject('Hold: @UserHold!', { UserHold: null })).toBe('Hold: !');
  });

  it('leaves unknown placeholders alone', () => {
    expect(renderSubject('Keep @Unknown here', { Ordr: 1 })).toBe('Keep @Unknown here');
  });

  it('handles an empty/null template', () => {
    expect(renderSubject(null, { A: 1 })).toBe('');
  });
});

describe('renderBody', () => {
  it('substitutes and HTML-escapes values', () => {
    expect(renderBody('Desc: @Description <br/>', { Description: 'A<B> & "C"' })).toBe(
      'Desc: A&lt;B&gt; &amp; &quot;C&quot; <br/>',
    );
  });

  it('longest param name wins when one prefixes another (@ItemCode vs @Item)', () => {
    const out = renderBody('@Item / @ItemCode / @ItemDescription', {
      Item: 'E1', ItemCode: 'E6193', ItemDescription: 'GRAY 10',
    });
    expect(out).toBe('E1 / E6193 / GRAY 10');
  });

  it('renders links for mapped fields when a base URL is set', () => {
    const out = renderBody('Ordr: @Ordr', { Ordr: 145915 }, { baseUrl: 'https://erp1.plant/', links: { Ordr: '/orders?focus=145915' } });
    expect(out).toBe('Ordr: <a href="https://erp1.plant/orders?focus=145915">145915</a>');
  });

  it('renders plain text without a base URL', () => {
    const out = renderBody('Ordr: @Ordr', { Ordr: 145915 }, { links: { Ordr: '/orders?focus=145915' } });
    expect(out).toBe('Ordr: 145915');
  });

  it('never renders a link around an empty value', () => {
    const out = renderBody('Ordr: @Ordr.', { Ordr: null }, { baseUrl: 'https://x', links: { Ordr: '/orders' } });
    expect(out).toBe('Ordr: .');
  });

  it('renders @Table', () => {
    const out = renderBody('Shorts:<br/>@Table', { }, {
      table: { columns: ['Item', 'Qty'], rows: [['E6193', 25], ['<odd>', null]] },
    });
    expect(out).toContain('<td class="header">Item</td>');
    expect(out).toContain('<td>E6193</td>');
    expect(out).toContain('<td>25</td>');
    expect(out).toContain('<td>&lt;odd&gt;</td>');
  });
});

describe('renderTableHtml', () => {
  it('escapes header and cell content', () => {
    const html = renderTableHtml({ columns: ['A&B'], rows: [['x"y']] });
    expect(html).toContain('A&amp;B');
    expect(html).toContain('x&quot;y');
  });
});

describe('wrapHtml', () => {
  it('produces a full html document around the body', () => {
    const html = wrapHtml('<p>hi</p>');
    expect(html).toContain('<html');
    expect(html).toContain('<p>hi</p>');
    expect(html).toContain('.header');
  });
});

describe('parseRecipients', () => {
  it('splits on semicolons and commas, trims, dedupes case-insensitively', () => {
    expect(parseRecipients('a@x.com; B@Y.com,a@X.COM ; ;c@z.com')).toEqual(['a@x.com', 'B@Y.com', 'c@z.com']);
  });

  it('drops entries without an @', () => {
    expect(parseRecipients('not-an-address; ops@plant.local')).toEqual(['ops@plant.local']);
  });

  it('merges multiple lists and ignores null/undefined', () => {
    expect(parseRecipients('a@x.com', null, undefined, 'b@y.com;a@x.com')).toEqual(['a@x.com', 'b@y.com']);
  });

  it('returns empty for nothing', () => {
    expect(parseRecipients(null, '')).toEqual([]);
  });
});
