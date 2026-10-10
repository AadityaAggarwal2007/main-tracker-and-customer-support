import type { Metadata } from 'next';
import { H2, LegalPage } from '../legal-page';

export const metadata: Metadata = { title: 'Privacy policy — ShipTrack', robots: { index: true } };

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy policy">
      <p>
        ShipTrack (shiptrack.store) is an order tracking and customer support service used by online stores.
        A store connects its orders to ShipTrack; its customers use ShipTrack to see where their order is and to
        reach the store&apos;s support team by chat, email or WhatsApp. This page says what information ShipTrack
        handles, why, and what you can ask for.
      </p>

      <H2>What we collect</H2>
      <ul>
        <li><strong>Order details</strong> the store shares with us: order number, the items, the delivery name, phone number, address, courier and tracking status. They exist so you can track your order and the store can help you with it.</li>
        <li><strong>Support messages</strong>: what you write in the chat widget on the store&apos;s website, by email to the store&apos;s support address, or on WhatsApp to the store&apos;s business number, together with the time and the WhatsApp profile name or email address you wrote from.</li>
        <li><strong>Verification</strong>: to show order details in a chat we ask for the order number and the phone number on the order. The phone number is used only to check that they match; it is not stored from the chat.</li>
        <li><strong>Refund details</strong> you type into a refund form sent to you by the store&apos;s team (UPI ID or bank account). They are encrypted and visible only to the store&apos;s owner.</li>
        <li><strong>Technical data</strong> needed to run the service: IP address and browser type in server logs, kept briefly for security and rate limiting.</li>
      </ul>

      <H2>How we use it</H2>
      <ul>
        <li>To show you your order&apos;s status and expected delivery date.</li>
        <li>To answer your support messages. A first reply may be written by an automated assistant; a person from the store&apos;s team can read every chat and take over at any time.</li>
        <li>To send order updates by email, and on WhatsApp only when you have messaged the store&apos;s number or agreed to receive updates.</li>
        <li>To protect the store and its customers against fraud and payment disputes.</li>
      </ul>

      <H2>WhatsApp</H2>
      <p>
        When you message a store&apos;s WhatsApp business number, your message, your phone number and your WhatsApp
        profile name are delivered to ShipTrack by Meta&apos;s WhatsApp Business Platform and shown to that store&apos;s
        support team. Replies are sent through the same platform. Meta&apos;s own handling of WhatsApp messages is
        described in WhatsApp&apos;s privacy policy. We do not use WhatsApp data for advertising and we do not sell it.
      </p>

      <H2>Who sees it</H2>
      <p>
        The store you ordered from and its support team, and ShipTrack as the provider that runs the service for the
        store. We use third-party providers only to deliver the service: Meta (WhatsApp messages), Google (the store&apos;s
        Gmail support mailbox), the courier (delivery), and an AI model provider that receives the text of the support
        conversation to draft replies. We never sell personal information.
      </p>

      <H2>How long we keep it</H2>
      <p>
        Order and support records are kept while the store uses ShipTrack and for as long as the store needs them for
        deliveries, refunds and payment disputes. Server logs are kept for a short time only.
      </p>

      <H2>Your rights</H2>
      <p>
        You can ask to see, correct or delete the information ShipTrack holds about you. See{' '}
        <a href="/data-deletion">Data deletion</a> for how. Contact the store&apos;s support team through the chat on its
        website, its support email, or its WhatsApp number; they will reach ShipTrack for anything they cannot do
        themselves.
      </p>

      <H2>Changes</H2>
      <p>If this policy changes, the new version is published here with a new date.</p>
    </LegalPage>
  );
}
