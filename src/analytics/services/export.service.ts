// src/analytics/services/export.service.ts
import { Injectable, Logger } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import { ExportFormat, ExportOptionsDto } from '../dtos/export-options.dto';
import { PrismaService } from '@/prisma/prisma.service';
import { AnalyticsService } from './analytics.service';

@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly analyticsService: AnalyticsService,
  ) {}

  /**
   * Generate analytics report in Excel, PDF, or CSV
   * @param options Export options including orgId, format, date range, and platform
   */
  // async generateReport(options: ExportOptionsDto): Promise<Buffer> {
  //   switch (options.format) {
  //     case ExportFormat.EXCEL:
  //       return this.generateExcelReport(options);
  //     case ExportFormat.PDF:
  //       return this.generatePdfReport(options);
  //     case ExportFormat.CSV:
  //       return this.generateCsvReport(options);
  //     default:
  //       throw new Error(`Unsupported format: ${options.format}`);
  //   }
  // }

  // private async generateExcelReport(
  //   options: ExportOptionsDto,
  // ): Promise<Buffer> {
  //   const workbook = new ExcelJS.Workbook();
  //   const worksheet = workbook.addWorksheet('Analytics Report');

  //   const data = await this.getExportData(options);
  //   worksheet.addRows(data);

  //   worksheet.getRow(1).font = { bold: true };

  //   const arrayBuffer = await workbook.xlsx.writeBuffer();
  //   return Buffer.from(arrayBuffer);
  // }

  // private async generatePdfReport(options: ExportOptionsDto): Promise<Buffer> {
  //   const data = await this.getExportData(options); // fetch first

  //   return new Promise((resolve) => {
  //     const doc = new PDFDocument();
  //     const buffers: Uint8Array[] = [];

  //     doc.on('data', buffers.push.bind(buffers));
  //     doc.on('end', () => resolve(Buffer.concat(buffers)));

  //     doc.fontSize(20).text('Analytics Report', { align: 'center' });
  //     doc.moveDown();

  //     data.forEach((row) => doc.text(row.join(': ')));

  //     doc.end();
  //   });
  // }
  // private async generateCsvReport(options: ExportOptionsDto): Promise<Buffer> {
  //   const data = await this.getExportData(options);
  //   const csv = data.map((row) => row.join(',')).join('\n');
  //   return Buffer.from(csv);
  // }

  // private async getExportData(options: ExportOptionsDto): Promise<any[][]> {
  //   const summary = await this.analyticsService.getOrganizationSummary(
  //     options.organizationId,
  //     {
  //       startDate: options.startDate?.toISOString(),
  //       endDate: options.endDate?.toISOString(),
  //       platform: options.platform,
  //     },
  //   );

  //   return [
  //     ['Metric', 'Value'],
  //     ['Total Likes', summary.totalLikes],
  //     ['Total Comments', summary.totalComments],
  //     ['Total Shares', summary.totalShares],
  //     ['Total Impressions', summary.totalImpressions],
  //     ['Total Clicks', summary.totalClicks],
  //     ['Engagement Rate', `${(summary.engagementRate * 100).toFixed(1)}%`],
  //     ['Click-Through Rate', `${(summary.clickThroughRate * 100).toFixed(1)}%`],
  //   ];
  // }
}
