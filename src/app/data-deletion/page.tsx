import type { Metadata } from 'next';
import { H2, LegalPage } from '../legal-page';

export const metadata: Metadata = { title: 'Data deletion — ShipTrack', robots: { index: true } };

export default function DataDeletionPage() {
  return (
    <LegalPage title="Data deletion">
      <p>You can ask for the information ShipTrack holds about you to be deleted.</p>

      <H2>How to ask</H2>
      <ol>
        <li>Write to the store you ordered from through the chat on its website, its support email, or its WhatsApp business number, and say &quot;Please delete my data&quot;.</li>
        <li>Give the order number and the phone number on the order, so we can find your records and check that they are yours.</li>
        <li>Within 30 days your chat, email and WhatsApp conversations with the store and the personal details on your order (name, phone number, address, email) are removed from ShipTrack. You get a confirmation in the same channel you wrote in.</li>
      </ol>

      <H2>What may be kept</H2>
      <p>
        A store must keep some order records for accounting, tax and payment-dispute reasons for the period the law
        requires. Those records are kept by the store under its own policy, without the conversation history.
      </p>

      <H2>WhatsApp</H2>
      <p>
        Deleting your data from ShipTrack removes the copy ShipTrack holds. Messages on your own phone and Meta&apos;s
        own records are handled by WhatsApp under its privacy policy.
      </p>
    </LegalPage>
  );
}
