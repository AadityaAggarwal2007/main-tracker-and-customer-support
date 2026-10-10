import type { Metadata } from 'next';
import { H2, LegalPage } from '../legal-page';

export const metadata: Metadata = { title: 'Terms of service — ShipTrack', robots: { index: true } };

export default function TermsPage() {
  return (
    <LegalPage title="Terms of service">
      <p>
        These terms apply to anyone using ShipTrack (shiptrack.store): the order tracking pages, the chat widget on a
        store&apos;s website, support by email or WhatsApp, and the store-side screens. By using ShipTrack you accept them.
      </p>

      <H2>What ShipTrack is</H2>
      <p>
        ShipTrack shows the status of an order placed with an online store and lets the store&apos;s support team talk
        with its customers. ShipTrack is not the seller and not the courier: the store is responsible for the order,
        the product, the delivery, refunds and returns under its own policies.
      </p>

      <H2>Order information</H2>
      <p>
        Tracking status and delivery dates are estimates based on the information the store and the courier provide.
        They can change. A date shown on ShipTrack is not a guarantee of delivery on that date.
      </p>

      <H2>Support conversations</H2>
      <ul>
        <li>Order details are shown in a chat only after the order number and the phone number on the order both match.</li>
        <li>A first reply may come from an automated assistant. Decisions about refunds, replacements or cancellations are made by the store&apos;s team, not by the assistant.</li>
        <li>Do not send card numbers, passwords or one-time codes in a chat, email or WhatsApp message. Payment details for a refund are given only through the refund form the store&apos;s team sends you.</li>
        <li>Be respectful. Abuse, threats or attempts to obtain someone else&apos;s order details may lead to the conversation being closed.</li>
      </ul>

      <H2>WhatsApp messages</H2>
      <p>
        By messaging a store&apos;s WhatsApp business number you agree to receive replies about your order on WhatsApp.
        You can stop at any time by writing STOP or by blocking the number. Messages go through Meta&apos;s WhatsApp
        Business Platform under WhatsApp&apos;s own terms.
      </p>

      <H2>Store accounts</H2>
      <p>
        A store that uses ShipTrack is responsible for its team&apos;s logins, for the accuracy of the order data it
        uploads or connects, and for answering its customers lawfully. ShipTrack may suspend access that is used to
        harm customers, other stores or the service.
      </p>

      <H2>Liability</H2>
      <p>
        ShipTrack is provided as it is. We work to keep it available and correct, but we do not guarantee uninterrupted
        service, and we are not liable for losses caused by delayed deliveries, courier errors, wrong information
        supplied by a store or a courier, or outages of third-party platforms such as WhatsApp or email.
      </p>

      <H2>Privacy</H2>
      <p>How personal information is handled is described in the <a href="/privacy">privacy policy</a>.</p>

      <H2>Changes</H2>
      <p>If these terms change, the new version is published here with a new date.</p>
    </LegalPage>
  );
}
