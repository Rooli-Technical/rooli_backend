import { InboxIngestService } from "@/inbox/services/inbox-ingest.service";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { Job } from "bullmq";

// @Processor('inbox-webhooks') // Listens to the NEW queue
// export class InboxWebhooksProcessor extends WorkerHost {
//   private readonly logger = new Logger(InboxWebhooksProcessor.name);

//   constructor(
//     private readonly inboxIngestService: InboxIngestService, // The service you wrote earlier!
//    // private readonly metaAdapter: MetaAdapter,
//   ) {
//     super();
//   }

//   // async process(job: Job<any>) {
//   //   try {
//   //     if (job.name === 'meta-inbound-message') {
//   //        // Convert messy Meta JSON into clean Rooli format
//   //        const normalizedData = this.metaAdapter.normalizeDirectMessage(job.data);
//   //        if (normalizedData) {
//   //           await this.inboxIngestService.ingestInboundMessage(normalizedData);
//   //           // TODO: Emit WebSocket event here
//   //        }
//   //     } 
//   //     else if (job.name === 'meta-inbound-comment') {
//   //        // handle comments...
//   //     }
//   //   } catch (error) {
//   //     this.logger.error(`Inbox Webhook Failed: ${error.message}`);
//   //     throw error;
//   //   }
//   // }
// }