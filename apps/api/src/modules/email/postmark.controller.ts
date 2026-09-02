import type { FastifyInstance } from "fastify";
import { config } from "../../config.js";
import { servicePool } from "../../lib/db.js";
import { badRequest } from "../../lib/errors.js";

/**
 * Postmark webhook handler for delivery and bounce events.
 * 
 * Postmark sends events as JSON array in the request body.
 * We update the message status based on the event type.
 */
export async function postmarkRoutes(app: FastifyInstance) {
  app.post(
    "/email/webhook/postmark",
    { config: { public: true } },
    async (req, reply) => {
      // Verify the Postmark server token via header (optional but recommended)
      const token = req.headers["x-postmark-server-token"];
      if (config.postmarkServerToken && token !== config.postmarkServerToken) {
        return badRequest("Invalid Postmark server token");
      }

      // Postmark sends an array of events
      const events = req.body as Array<{
        Type: string; // e.g., "Delivery", "Open", "Click", "Bounce", "SpamComplaint"
        MessageID: string; // The MessageID from the send response
        [key: string]: any; // other fields
      }>;

      if (!Array.isArray(events)) {
        // Single event fallback (though Postmark always sends array)
        return badRequest("Expected array of events");
      }

      const client = await servicePool.connect();
      try {
        await client.query("BEGIN");
        for (const event of events) {
          const { Type, MessageID } = event;
          if (!MessageID) continue;

          // Map Postmark event types to our message status
          let status: string | null = null;
          switch (Type) {
            case "Delivery":
              status = "delivered";
              break;
            case "Open":
              status = "opened";
              break;
            case "Click":
              status = "clicked";
              break;
            case "Bounce":
              status = "bounced";
              break;
            case "SpamComplaint":
              status = "failed"; // or we could have a separate status, but failed is fine
              break;
            default:
              // Ignore unknown event types
              continue;
          }

          if (status) {
            await client.query(
              `UPDATE messages SET status = $1 WHERE provider_msg_id = $2`,
              [status, MessageID],
            );
          }
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      return reply.send({ received: true });
    },
  );
}