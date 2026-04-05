import { Controller, Get, HttpStatus, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { AppService } from './app.service';
import { StandardResponse } from './@types/interface/response';
import { Public } from './common/decorators/public.decorator';

@ApiTags('System')
@Controller({
  version: VERSION_NEUTRAL,
})
export class AppController {
  constructor(private readonly appService: AppService) {}

  // ================================================================
  //. Health Check
  // ================================================================
  @Get('health')
  @Public()
  @ApiOperation({
    summary: 'Health Check',
    description: 'Check if the API Gateway and Database are running correctly',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'System is healthy',
    schema: {
      example: {
        success: true,
        statusCode: HttpStatus.OK,
        data: null,
        message: 'Api Gateway running successfully',
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description: 'System is unhealthy (e.g. Database connection failed)',
  })
  async getHealth(): Promise<StandardResponse<any>> {
    await this.appService.getHealth();

    return {
      success: true,
      data: null,
      statusCode: HttpStatus.OK,
      message: 'System is healthy',
    };
  }
}
