import { AfterViewInit, Component, Input, OnInit, ViewChild } from '@angular/core';
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

export enum ACTION_BUTTONS {
  VIEW_IN_WEB,
  MARK_AS_RESPONDED,
  MARK_AS_PENDING,
  RESPOND_TO_ISSUE,
  FIX_ISSUE,
  DELETE_ISSUE,
  ELIMINATE_ISSUE
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

  @ViewChild(MatSort, { static: true }) sort: MatSort;
  @ViewChild(MatPaginator, { static: true }) paginator: MatPaginator;

  issues: IssuesDataTable;
  issuesPendingDeletion: { [id: number]: boolean };

  public tableSettings: TableSettings;

  public readonly action_buttons = ACTION_BUTTONS;

  // Messages for the modal popup window upon deleting an issue
  private readonly deleteIssueModalMessages = ['Do you wish to delete this issue?', 'This action is irreversible!'];
  private readonly yesButtonModalMessageDeleteIssue = 'Yes, I wish to delete this issue';
  private readonly noButtonModalMessageDeleteIssue = "No, I don't wish to delete this issue";

  // Messages for the modal popup window upon deleting eliminated issues
  private readonly deleteEliminatedIssuesModalMessages = ['Do you wish to delete eliminated issues?', 'This action is irreversible!'];
  private readonly yesButtonModalMessageDeleteEliminatedIssues = 'Yes, I wish to delete them';
  private readonly noButtonModalMessageDeleteEliminatedIssues = "No, I don't wish to delete them";

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
  }

  ngAfterViewInit(): void {
    setTimeout(() => {
      this.issues.loadIssues();
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
    this.deleteOneIssue(id, event);

    let snackBarRef = null;
    snackBarRef = this.snackBar.openFromComponent(UndoActionComponent, {
      data: { message: `Deleted issue ${id}` },
      duration: this.snackBarAutoCloseTime
    });
    snackBarRef.onAction().subscribe(() => {
      this.undeleteIssue(id, event);
    });
  }

  private deleteOneIssue(id: number, event: Event) {
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
  }

  undeleteIssue(id: number, event: Event) {
    this.undeleteOneIssue(id, event);

    this.snackBar.open(`Restored issue ${id}`, '', { duration: this.snackBarAutoCloseTime });
  }

  undeleteEliminatedIssues(event: Event) {
    for (let issue of this.issueService.eliminatedIssues) {
      this.undeleteOneIssue(issue.id, event);
    }

    this.snackBar.open('Restored eliminated issues', '', { duration: this.snackBarAutoCloseTime });
  }

  private undeleteOneIssue(id: number, event: Event) {
    this.logger.info(`IssueTablesComponent: Undeleting Issue ${id}`);
    this.issueService.undeleteIssue(id).subscribe(
      (reopenedIssue) => {},
      (error) => {
        this.errorHandlingService.handleError(error);
      }
    );
    event.stopPropagation();
  }

  openDeleteDialog(id: number, event: Event) {
    const dialogRef = this.dialogService.openUserConfirmationModal(
      this.deleteIssueModalMessages,
      this.yesButtonModalMessageDeleteIssue,
      this.noButtonModalMessageDeleteIssue
    );

    dialogRef.afterClosed().subscribe((res) => {
      if (res) {
        this.logger.info(`IssueTablesComponent: Deleting issue ${id}`);
        this.deleteIssue(id, event);
      }
    });
  }

  openDeleteEliminatedDialog(event: Event) {
    const dialogRef = this.dialogService.openUserConfirmationModal(
      this.deleteEliminatedIssuesModalMessages,
      this.yesButtonModalMessageDeleteEliminatedIssues,
      this.noButtonModalMessageDeleteEliminatedIssues
    );

    dialogRef.afterClosed().subscribe((res) => {
      if (res) {
        this.logger.info('IssueTablesComponent: Deleting eliminated issues');
        this.deleteEliminatedIssues(event);
      }
    });
  }

  deleteEliminatedIssues(event: Event) {
    // Loop through set of eliminated issues and delete them
    for (let issue of this.issueService.eliminatedIssues) {
      this.deleteOneIssue(issue.id, event);
    }
    // Show snackbar to undo
    let snackBarRef = null;
    snackBarRef = this.snackBar.openFromComponent(UndoActionComponent, {
      data: { message: 'Deleted all eliminated issues' },
      duration: this.snackBarAutoCloseTime
    });
    snackBarRef.onAction().subscribe(() => {
      this.undeleteEliminatedIssues(event);
      return;
    });
    // If no undo, clear eliminated issues set
    setTimeout(() => {
      this.issueService.eliminatedIssues.clear();
    }, this.snackBarAutoCloseTime);
  }
}
