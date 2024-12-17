import { AfterViewInit, Component, Input, OnInit, Output, ViewChild } from '@angular/core';
import { MatPaginator, PageEvent } from '@angular/material/paginator';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatSort, Sort } from '@angular/material/sort';
import { finalize } from 'rxjs/operators';
import { Issue, STATUS } from '../../core/models/issue.model';
import { TableSettings } from '../../core/models/table-settings.model';
import { DialogService } from '../../core/services/dialog.service';
import { ErrorHandlingService } from '../../core/services/error-handling.service';
import { GithubService } from '../../core/services/github.service';
import { IssueTableSettingsService } from '../../core/services/issue-table-settings.service';
import { IssueService } from '../../core/services/issue.service';
import { LabelService } from '../../core/services/label.service';
import { LoggingService } from '../../core/services/logging.service';
import { PermissionService } from '../../core/services/permission.service';
import { PhaseService } from '../../core/services/phase.service';
import { UserService } from '../../core/services/user.service';
import { UndoActionComponent } from '../../shared/action-toasters/undo-action/undo-action.component';
import { IssuesDataTable } from './IssuesDataTable';
import { EventEmitter } from '@angular/core';

export enum ACTION_BUTTONS {
  VIEW_IN_WEB,
  MARK_AS_RESPONDED,
  MARK_AS_PENDING,
  RESPOND_TO_ISSUE,
  FIX_ISSUE,
  DELETE_ISSUE
}

@Component({
  selector: 'app-issue-tables',
  templateUrl: './issue-tables.component.html',
  styleUrls: ['./issue-tables.component.css']
})
export class IssueTablesComponent implements OnInit, AfterViewInit {
  snackBarAutoCloseTime = 3000;

  @Input() headers: string[];
  @Input() actions: ACTION_BUTTONS[];
  @Input() filters?: any = undefined;
  @Input() table_name: string;
  @Output() countChanged = new EventEmitter();

  @ViewChild(MatSort, { static: true }) sort: MatSort;
  @ViewChild(MatPaginator, { static: true }) paginator: MatPaginator;

  issues: IssuesDataTable;
  issuesPendingDeletion: { [id: number]: boolean };

  typeCount: Map<string, number> = new Map();
  severityCount: Map<string, number> = new Map();

  public tableSettings: TableSettings;

  public readonly action_buttons = ACTION_BUTTONS;

  // Messages for the modal popup window upon deleting an issue
  private readonly deleteIssueModalMessages = ['Do you wish to delete this issue?', 'This action is irreversible!'];
  private readonly yesButtonModalMessage = 'Yes, I wish to delete this issue';
  private readonly noButtonModalMessage = "No, I don't wish to delete this issue";

  constructor(
    public userService: UserService,
    public permissions: PermissionService,
    public labelService: LabelService,
    private githubService: GithubService,
    public issueService: IssueService,
    public issueTableSettingsService: IssueTableSettingsService,
    private phaseService: PhaseService,
    private errorHandlingService: ErrorHandlingService,
    private logger: LoggingService,
    private dialogService: DialogService,
    private snackBar: MatSnackBar = null
  ) {}

  ngOnInit() {
    this.issues = new IssuesDataTable(this.issueService, this.sort, this.paginator, this.headers, this.filters);
    this.issuesPendingDeletion = {};
    this.tableSettings = this.issueTableSettingsService.getTableSettings(this.table_name);
    this.initLabelCounts();
  }

  ngAfterViewInit(): void {
    setTimeout(() => {
      this.issues.loadIssues();
      this.getLabelsCount();
    });
  }

  sortChange(newSort: Sort) {
    this.tableSettings.sortActiveId = newSort.active;
    this.tableSettings.sortDirection = newSort.direction;
    this.issueTableSettingsService.setTableSettings(this.table_name, this.tableSettings);
  }

  pageChange(pageEvent: PageEvent) {
    this.tableSettings.pageSize = pageEvent.pageSize;
    this.tableSettings.pageIndex = pageEvent.pageIndex;
    this.issueTableSettingsService.setTableSettings(this.table_name, this.tableSettings);
  }

  isActionVisible(action: ACTION_BUTTONS): boolean {
    return this.actions.includes(action);
  }

  markAsResponded(issue: Issue, event: Event) {
    this.logger.info(`IssueTablesComponent: Marking Issue ${issue.id} as Responded`);
    const newIssue = issue.clone(this.phaseService.currentPhase);
    newIssue.status = STATUS.Done;
    this.issueService.updateIssue(newIssue).subscribe(
      (updatedIssue) => {
        this.issueService.updateLocalStore(updatedIssue);
      },
      (error) => {
        this.errorHandlingService.handleError(error);
      }
    );
    event.stopPropagation();
  }

  isResponseEditable() {
    return this.permissions.isTeamResponseEditable() || this.permissions.isTesterResponseEditable();
  }

  markAsPending(issue: Issue, event: Event) {
    this.logger.info(`IssueTablesComponent: Marking Issue ${issue.id} as Pending`);
    const newIssue = issue.clone(this.phaseService.currentPhase);
    newIssue.status = STATUS.Incomplete;
    this.issueService.updateIssue(newIssue).subscribe(
      (updatedIssue) => {
        this.issueService.updateLocalStore(updatedIssue);
      },
      (error) => {
        this.errorHandlingService.handleError(error);
      }
    );
    event.stopPropagation();
  }

  logIssueRespondRouting(id: number) {
    this.logger.info(`IssueTablesComponent: Proceeding to Respond to Issue ${id}`);
  }

  logIssueEditRouting(id: number) {
    this.logger.info(`IssueTablesComponent: Proceeding to Edit Issue ${id}`);
  }

  /**
   * Gets the number of resolved disputes.
   */
  todoFinished(issue: Issue): number {
    return issue.issueDisputes.length - issue.numOfUnresolvedDisputes();
  }

  /**
   * Checks if all the disputes are resolved.
   */
  isTodoListChecked(issue: Issue): boolean {
    return issue.issueDisputes && issue.numOfUnresolvedDisputes() === 0;
  }

  viewIssueInBrowser(id: number, event: Event) {
    this.logger.info(`IssueTablesComponent: Opening Issue ${id} on Github`);
    this.githubService.viewIssueInBrowser(id, event);
  }

  deleteIssue(id: number, event: Event) {
    this.logger.info(`IssueTablesComponent: Deleting Issue ${id}`);
    this.issuesPendingDeletion = {
      ...this.issuesPendingDeletion,
      [id]: true
    };
    this.issueService
      .deleteIssue(id)
      .pipe(
        finalize(() => {
          const { [id]: issueRemoved, ...theRest } = this.issuesPendingDeletion;
          this.issuesPendingDeletion = theRest;
        })
      )
      .subscribe(
        (removedIssue) => {},
        (error) => {
          this.errorHandlingService.handleError(error);
        }
      );
    event.stopPropagation();

    let snackBarRef = null;
    snackBarRef = this.snackBar.openFromComponent(UndoActionComponent, {
      data: { message: `Deleted issue ${id}` },
      duration: this.snackBarAutoCloseTime
    });
    snackBarRef.onAction().subscribe(() => {
      this.undeleteIssue(id, event);
    });
  }

  undeleteIssue(id: number, event: Event) {
    this.logger.info(`IssueTablesComponent: Undeleting Issue ${id}`);
    this.issueService.undeleteIssue(id).subscribe(
      (reopenedIssue) => {},
      (error) => {
        this.errorHandlingService.handleError(error);
      }
    );
    event.stopPropagation();

    this.snackBar.open(`Restored issue ${id}`, '', { duration: this.snackBarAutoCloseTime });
  }

  openDeleteDialog(id: number, event: Event) {
    const dialogRef = this.dialogService.openUserConfirmationModal(
      this.deleteIssueModalMessages,
      this.yesButtonModalMessage,
      this.noButtonModalMessage
    );

    dialogRef.afterClosed().subscribe((res) => {
      if (res) {
        this.logger.info(`IssueTablesComponent: Deleting issue ${id}`);
        this.deleteIssue(id, event);
      }
    });
  }

  getLabelsCount() {
    this.issues.connect().subscribe((data) => {
      // Reset count
      const typeLabelStrings = this.getTypeLabelStrings();
      const severityLabelStrings = this.getSeverityLabelStrings();

      for (let label of typeLabelStrings) {
        this.typeCount[label] = 0;
      }
      for (let label of severityLabelStrings) {
        this.severityCount[label] = 0;
      }

      // Update count
      for (let issue of data) {
        this.severityCount[issue.severity]++;
        this.typeCount[issue.type]++;
      }

      console.log('FROM ISSUE TABLES COMPONENT:');
      console.log(this.typeCount);
      console.log(this.severityCount);

      this.countChanged.emit();
    });
  }

  initLabelCounts() {
    const typeLabelStrings: string[] = this.getTypeLabelStrings();
    const severityLabelStrings: string[] = this.getSeverityLabelStrings();

    for (let severityLabelName of severityLabelStrings) {
      this.severityCount[severityLabelName] = 0;
    }

    let typeCount = new Map();
    for (let typeLabelName of typeLabelStrings) {
      this.typeCount[typeLabelName] = 0;
    }
  }

  private getSeverityLabelStrings(): string[] {
    return this.labelService.getLabelList('severity').map((label) => label.labelValue);
  }

  private getTypeLabelStrings(): string[] {
    return this.labelService.getLabelList('type').map((label) => label.labelValue);
  }
}
