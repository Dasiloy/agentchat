export interface PaginateQuery {
  /** page number requested */
  page: number;

  /** records per page requested */
  limit: number;
}

export interface PaginateDto extends PaginateQuery {
  /** number of total records in db */
  total: number;

  /** number of records in the current page requested */
  pageSize: number;
}

export interface PaginateResponse extends PaginateDto {
  /** the very last page available for fetch */
  lastPage: number;
}

export interface StandardResponse<T> {
  /** success boolean (true/false)  for quick vcerification of request */
  success: boolean;

  /** custom message response, can be displayed on FE for UX */
  message: string;

  /** actual server data being sent back, null if no feedback is given */
  data: T | null;

  /** http status given for quick FE check, also available in headers */
  statusCode: number;

  /** pagination meta structure for infinite or divide and conquer search */
  meta?: PaginateResponse;
}
