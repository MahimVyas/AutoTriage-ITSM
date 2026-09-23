"""Seed AutoTriage-ITSM with users, KB runbooks and mock historical tickets.

Usage:
    python seed.py            # idempotent — skips if data already exists
    python seed.py --reset    # wipe ticket/KB/audit tables first

Deterministic: KB embeddings use the local hashing embedder (no API key
required), so the hybrid RAG demo works offline out of the box.
"""

import argparse
import asyncio
import random
import uuid
from datetime import datetime, timedelta

from sqlalchemy import delete, select

from src.database import (
    AIAuditLogs,
    AI_Tier,
    Base,
    KB_Documents,
    SLAEvents,
    TicketCategory,
    TicketSeverity,
    TicketStatus,
    Tickets,
    Users,
    UserRole,
    engine,
    async_session_maker,
)
from src.services.ai_classifier import get_ai_classifier
from src.services.embeddings import local_embed
from src.services.pii_scrubber import get_pii_scrubber
from src.workers.sla_worker import compute_sla_deadline, sla_window_seconds

# --------------------------------------------------------------------------- #
# Sample users
# --------------------------------------------------------------------------- #
USERS = [
    ("Avery Chen", "avery.chen@autotriage.dev", UserRole.EMPLOYEE),
    ("Priya Nair", "priya.nair@autotriage.dev", UserRole.EMPLOYEE),
    ("Marcus Webb", "marcus.webb@autotriage.dev", UserRole.EMPLOYEE),
    ("Dana Okafor", "dana.okafor@autotriage.dev", UserRole.AGENT),
    ("Leo Martins", "leo.martins@autotriage.dev", UserRole.AGENT),
    ("Sofia Reyes", "sofia.reyes@autotriage.dev", UserRole.AGENT),
    ("Jordan Blake", "jordan.blake@autotriage.dev", UserRole.ADMIN),
]

# --------------------------------------------------------------------------- #
# 5+ IT runbooks for the hybrid RAG engine
# --------------------------------------------------------------------------- #
KB_RUNBOOKS = [
    (
        "Laptop Won't Power On — Hardware Triage Runbook",
        "HARDWARE",
        """Runbook: laptop power faults.
1. Verify the wall outlet works by testing with a known-good device.
2. Inspect the AC adapter and LED indicators; a blinking amber light usually means a battery fault.
3. Perform a power drain: unplug the charger, remove the battery if removable, hold power for 30 seconds.
4. Reseat the RAM module and reconnect the internal display cable before replacing the mainboard.
5. If the machine posts, run the vendor diagnostics suite and log the asset tag in the CMDB.""",
    ),
    (
        "VPN Connectivity Failure — Network Runbook",
        "NETWORK",
        """Runbook: remote VPN connectivity.
1. Confirm basic internet access first; ping 1.1.1.1 from the command line.
2. Restart the VPN client service and reconnect using the regional gateway closest to the user.
3. Flush the DNS cache with ipconfig /flushdns and verify the split-tunnel routes.
4. Check the authentication logs in the VPN concentrator for expired certificates or MFA denials.
5. If the tunnel still fails, escalate to Network Ops with the client log bundle attached.""",
    ),
    (
        "Password Reset & Account Lockout — IAM Runbook",
        "IAM_ACCESS",
        """Runbook: password reset and lockout recovery.
1. Verify the requester's identity through the approved verification channel before any reset.
2. Confirm the account is not locked by repeated failed logins in the identity provider console.
3. Trigger a self-service password reset; ensure the new password meets the 14-character policy.
4. Ask the user to re-authenticate and confirm MFA push delivery on their registered device.
5. If lockouts recur, review sign-in logs for impossible-travel or token-replay patterns.""",
    ),
    (
        "Suspicious Phishing Report — Security Incident Runbook",
        "SECURITY",
        """Runbook: phishing and account-compromise response.
1. Isolate the affected mailbox and revoke active sessions and refresh tokens immediately.
2. Capture full email headers and report the message to the security mailbox for analysis.
3. Reset credentials for any account that clicked the link and force an MFA re-registration.
4. Search the tenant for sibling messages and purge them with a mailflow rule.
5. Open a P1 incident record, notify the on-call security engineer and preserve evidence.""",
    ),
    (
        "Slow Application & Crash — Software Runbook",
        "SOFTWARE",
        """Runbook: application crashes and degraded performance.
1. Collect the application event logs and the crash dump from %LOCALAPPDATA%.
2. Confirm the application build matches the approved version in the software catalog.
3. Clear the cache directory and restart the service to rule out stale state.
4. Reproduce the fault with a test account and record the exact reproduction steps.
5. If reproducible, file a vendor ticket with the dump and escalate to the application owner.""",
    ),
    (
        "Printer Offline & Jam Recovery — Hardware Runbook",
        "HARDWARE",
        """Runbook: shared printer offline.
1. Check the printer display for paper jam or low-toner indicators and clear any jammed sheets.
2. Verify the device has a valid IP on the office VLAN by printing a configuration page.
3. Ping the printer from a workstation; restart the print spooler if the queue is stuck.
4. Re-add the printer on the affected workstation using the discovery tool.
5. If the fuser or drum is reported faulty, raise a vendor service call with the serial number.""",
    ),
    (
        "DNS Resolution Failures — Network Runbook",
        "NETWORK",
        """Runbook: DNS resolution failures.
1. Test resolution with nslookup against the internal resolver and a public resolver.
2. Flush the local DNS cache and renew the DHCP lease on the workstation.
3. Confirm the resolver pair is reachable and check the forwarding rules on the DNS server.
4. Review the resolver query log for SERVFAIL patterns or zone transfer errors.
5. Fail over clients to the secondary resolver if the primary is degraded.""",
    ),
]


# --------------------------------------------------------------------------- #
# Mock historical tickets (title, description, category hint, age_hours,
# status, breach?, override?)
# --------------------------------------------------------------------------- #
TICKETS = [
    ("Laptop will not power on", "My ThinkPad stopped turning on this morning. The charging LED blinks amber and holding the power button does nothing.", 26, TicketStatus.CLOSED, False, False),
    ("VPN keeps dropping every few minutes", "Remote VPN connection drops after 2-3 minutes. Flushing dns did not help. IP 10.4.19.22 keeps timing out.", 30, TicketStatus.RESOLVED, False, True),
    ("Password reset for payroll portal", "User priya.nair@autotriage.dev needs a password reset, she is locked out after too many attempts. Her SSN on file is 123-45-6789 for HR verification.", 20, TicketStatus.CLOSED, False, False),
    ("Suspicious phishing email received", "Finance received an invoice email asking us to log in at a fake portal. Two users clicked the link. Credit card 4111 1111 1111 1111 was in the attached form.", 4, TicketStatus.IN_PROGRESS, False, False),
    ("Outlook crashes when opening attachments", "Outlook closes instantly when I open any PDF attachment. Happens every time since the last update.", 50, TicketStatus.RESOLVED, False, True),
    ("Shared printer shows offline", "The 3rd floor HP printer is showing offline for everyone. There is a paper jam warning on the display.", 54, TicketStatus.CLOSED, False, False),
    ("Wi-Fi extremely slow in building B", "Wifi in building B is unusable, speedtest shows 1 Mbps down and latency over 300 ms.", 8, TicketStatus.OPEN, True, False),
    ("Cannot access shared drive", "Access denied when mapping the finance shared drive. I am in the correct AD group as far as I know.", 6, TicketStatus.OPEN, False, False),
    ("MFA push not arriving", "The MFA push notification never arrives on my phone so I cannot log in to SSO at all.", 2, TicketStatus.OPEN, False, False),
    ("Suspected malware on workstation", "Windows Defender keeps flagging a suspicious process named updsvc.exe restarting after reboot. Possible breach?", 1, TicketStatus.OPEN, False, True),
    ("Monitor flickers intermittently", "The external monitor flickers every few minutes on the USB-C dock.", 72, TicketStatus.CLOSED, False, False),
    ("Request: install statistical software", "Please install the approved statistics package on my workstation for the quarterly analysis work.", 96, TicketStatus.CLOSED, False, False),
    ("DNS not resolving internal sites", "Internal sites fail to resolve but external ones work. nslookup times out against 10.0.0.53.", 3, TicketStatus.OPEN, False, False),
    ("Blue screen after driver update", "Laptop shows a blue screen on boot after yesterday's driver update, stop code CRITICAL_PROCESS_DIED.", 5, TicketStatus.IN_PROGRESS, False, False),
]

OVERRIDE_NOTES = [
    "Category corrected — actual root cause was network-side, not software.",
    "Severity raised: multiple users affected, not a single-user issue.",
    "Misclassified as hardware; this is an IAM access request.",
]


async def seed(reset: bool = False) -> None:
    async with engine.begin() as conn:
        try:
            await conn.execute(
                __import__("sqlalchemy").text("CREATE EXTENSION IF NOT EXISTS vector")
            )
        except Exception as exc:  # non-Postgres dev backend
            print(f"(pgvector extension unavailable, continuing: {exc})")
        await conn.run_sync(Base.metadata.create_all)

    async with async_session_maker() as session:
        existing = (await session.execute(select(Users).limit(1))).scalars().first()

        if reset and existing:
            for model in (AIAuditLogs, SLAEvents, Tickets, KB_Documents, Users):
                await session.execute(delete(model))
            await session.commit()
            existing = None

        if existing is not None:
            print("Seed data already present — nothing to do (use --reset to wipe).")
            return

        # --- users ------------------------------------------------------- #
        users: dict[str, Users] = {}
        for name, email, role in USERS:
            user = Users(name=name, email=email, role=role)
            session.add(user)
            users[email] = user
        await session.flush()

        # --- knowledge base ---------------------------------------------- #
        print(f"Embedding {len(KB_RUNBOOKS)} knowledge-base runbooks ...")
        kb_docs = []
        for title, category, content in KB_RUNBOOKS:
            doc = KB_Documents(
                title=title,
                content=content,
                category=category,
                embedding=local_embed(f"{title} {category} {content}"),
            )
            session.add(doc)
            kb_docs.append(doc)
        await session.flush()

        # --- historical tickets ------------------------------------------ #
        classifier = await get_ai_classifier()
        scrubber = get_pii_scrubber()
        agents = [users[e] for e in ("dana.okafor@autotriage.dev", "leo.martins@autotriage.dev", "sofia.reyes@autotriage.dev")]
        rng = random.Random(42)

        created: list[Tickets] = []
        for i, (title, desc, age_hours, status, force_breach, will_override) in enumerate(TICKETS):
            scrubbed = scrubber.scrub_text(desc)
            # Tier-1 only for seed speed; deterministic rule fallback when needed
            classification = classifier.tier1(f"{title}\n{scrubbed}") or classifier.rule_fallback(f"{title}\n{scrubbed}")

            created_at = datetime.utcnow() - timedelta(hours=age_hours)
            deadline = created_at + timedelta(seconds=sla_window_seconds(classification.severity.value))
            breached = force_breach or (status in (TicketStatus.OPEN, TicketStatus.IN_PROGRESS) and deadline < datetime.utcnow())

            ticket = Tickets(
                title=title,
                raw_description=desc,
                scrubbed_description=scrubbed,
                category=classification.category,
                subcategory=classification.subcategory or None,
                severity=classification.severity,
                status=TicketStatus.ESCALATED if force_breach else status,
                confidence_score=classification.confidence_score,
                ai_tier_used=classification.ai_tier_used,
                ai_summary=classification.summary,
                ai_reasoning=classification.reasoning,
                troubleshooting_steps=None,
                created_by_id=users[USERS[i % 3][1]].id,
                assigned_agent_id=rng.choice(agents).id if status != TicketStatus.OPEN else None,
                created_at=created_at,
                sla_deadline=deadline,
                is_sla_breached=breached,
            )

            # Link plausible KB runbooks while the ticket is still pending
            # (avoids an async lazy-load of the collection).
            matches = [d for d in kb_docs if d.category == ticket.category.value]
            if matches:
                ticket.kb_documents = matches[:2]
                ticket.troubleshooting_steps = [
                    f"Review the '{matches[0].title}' runbook and confirm the reported symptom.",
                    "Collect environment details (device, OS build, error text) from the requester.",
                    "Apply the runbook fix or escalate with diagnostics attached if unresolved.",
                ]

            session.add(ticket)
            created.append(ticket)
            await session.flush()

            if breached:
                session.add(
                    SLAEvents(
                        ticket_id=ticket.id,
                        event_type="BREACH",
                        message=f"SLA breached for '{title}' — escalated to P1_CRITICAL",
                        timestamp=deadline + timedelta(seconds=1),
                    )
                )

            if will_override:
                original_category = ticket.category.value
                original_severity = ticket.severity.value
                # Simulate the agent correcting the AI
                new_category = rng.choice([c for c in TicketCategory if c != ticket.category and c != TicketCategory.SECURITY])
                ticket.category = new_category
                session.add(
                    AIAuditLogs(
                        ticket_id=ticket.id,
                        original_category=original_category,
                        corrected_category=new_category.value,
                        original_severity=original_severity,
                        corrected_severity=None,
                        corrected_by_agent_id=rng.choice(agents).id,
                        note=OVERRIDE_NOTES[i % len(OVERRIDE_NOTES)],
                        timestamp=ticket.created_at + timedelta(minutes=rng.randint(5, 90)),
                    )
                )

            # Link a couple of plausible KB runbooks for provenance — done
            # while the ticket is pending (see above) to avoid lazy loads.

        await session.commit()
        print(
            f"Seeded {len(USERS)} users, {len(KB_RUNBOOKS)} KB runbooks, "
            f"{len(TICKETS)} tickets with audit/SLA history."
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed AutoTriage-ITSM demo data")
    parser.add_argument("--reset", action="store_true", help="wipe existing data first")
    args = parser.parse_args()
    asyncio.run(seed(reset=args.reset))


if __name__ == "__main__":
    main()
