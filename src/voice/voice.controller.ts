import {
  Controller,
  FileTypeValidator,
  HttpStatus,
  MaxFileSizeValidator,
  ParseFilePipe,
  Post,
  UploadedFile,
  UseInterceptors,
  Body,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { CurrentUser } from '../common/decorators/current-user.decorator';
import { StandardResponse } from '../@types/interface/response';
import {
  ALLOWED_MIME_PATTERN,
  MAX_FILE_SIZE,
} from '../@types/constants/constants';
import { VoiceService } from './voice.service';

@ApiTags('Voice')
@ApiBearerAuth()
@Controller('voice')
export class VoiceController {
  constructor(private readonly voiceService: VoiceService) {}

  // ================================================================
  //. Uplod Voice Chat to Cloudinary
  // ================================================================
  @Post('upload')
  @ApiOperation({
    summary: 'Upload a voice message — transcription runs in background',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'roomId'],
      properties: {
        file: { type: 'string', format: 'binary' },
        roomId: { type: 'string', example: 'clh0abc123roomid0001' },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Voice message uploaded — transcription pending',
    schema: {
      example: {
        success: true,
        statusCode: HttpStatus.CREATED,
        message: 'Voice message uploaded',
        data: { messageId: 'clh0abc123msgid0001', status: 'transcribing' },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid file type or size',
  })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Unauthorized' })
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: MAX_FILE_SIZE }),
          new FileTypeValidator({ fileType: ALLOWED_MIME_PATTERN }),
        ],
      }),
    )
    file: Express.Multer.File,
    @Body('roomId') roomId: string,
    @CurrentUser() user: { id: string },
  ): Promise<StandardResponse<{ messageId: string; status: string }>> {
    const data = await this.voiceService.uploadVoice(file, roomId, user.id);
    return {
      success: true,
      message: 'Voice message uploaded',
      data,
      statusCode: HttpStatus.CREATED,
    };
  }
}
