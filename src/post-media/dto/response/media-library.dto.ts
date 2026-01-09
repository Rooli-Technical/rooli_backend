import { ApiProperty } from "@nestjs/swagger";
import { MediaFileDto } from "./media-file.dto";
import { MediaFolderDto } from "./media-folder.dto";

export class MediaLibraryResponseDto {
  @ApiProperty({ type: [MediaFolderDto] })
  folders: MediaFolderDto[];

  @ApiProperty({ type: [MediaFileDto] })
  files: MediaFileDto[];
}
